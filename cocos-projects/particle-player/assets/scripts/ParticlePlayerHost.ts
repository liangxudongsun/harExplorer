import {
  _decorator,
  Component,
  Node,
  ParticleSystem2D,
  SpriteFrame,
  Texture2D,
  ImageAsset,
  assetManager,
  Color,
  Vec2,
  Vec3,
  UITransform,
  input,
  Input,
  EventMouse,
  EventTouch,
  view,
  Camera,
  find,
} from 'cc';

const { ccclass, property } = _decorator;

export type ParticleLoadMessage = {
  type: 'particle';
  cmd: 'load';
  plistUrl?: string;
  textureUrl?: string;
  params?: Record<string, unknown>;
  /** default true — emitter follows pointer (trail preview) */
  follow?: boolean;
};

export type ParticleControlMessage = {
  type: 'particle';
  cmd: 'play' | 'pause' | 'restart' | 'stop' | 'follow';
  enabled?: boolean;
};

/**
 * iframe / parent postMessage bridge for harExplore particle preview.
 */
@ccclass('ParticlePlayerHost')
export class ParticlePlayerHost extends Component {
  @property(ParticleSystem2D)
  particle: ParticleSystem2D | null = null;

  @property(Node)
  particleNode: Node | null = null;

  private _follow = true;
  private _uiCamera: Camera | null = null;
  private _tmp = new Vec3();

  onLoad() {
    if (!this.particle) {
      const n = this.particleNode ?? this.node.getChildByName('Particle') ?? this.node;
      this.particle = n.getComponent(ParticleSystem2D);
      if (!this.particleNode) this.particleNode = n;
    }
    this._uiCamera =
      find('Canvas/Camera')?.getComponent(Camera) ??
      this.node.scene?.getComponentInChildren(Camera) ??
      null;

    this._bindMessage();
    this._bindPointer();
    this._post({ type: 'particle', event: 'ready' });
  }

  onDestroy() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this._onMessage);
    }
    input.off(Input.EventType.MOUSE_MOVE, this._onMouseMove, this);
    input.off(Input.EventType.TOUCH_MOVE, this._onTouchMove, this);
  }

  private _bindMessage = () => {
    if (typeof window === 'undefined') return;
    window.addEventListener('message', this._onMessage);
  };

  private _bindPointer() {
    input.on(Input.EventType.MOUSE_MOVE, this._onMouseMove, this);
    input.on(Input.EventType.TOUCH_MOVE, this._onTouchMove, this);
  }

  private _onMouseMove = (ev: EventMouse) => {
    if (!this._follow) return;
    const loc = ev.getUILocation();
    this._moveEmitter(loc.x, loc.y);
  };

  private _onTouchMove = (ev: EventTouch) => {
    if (!this._follow) return;
    const loc = ev.getUILocation();
    this._moveEmitter(loc.x, loc.y);
  };

  private _moveEmitter(uiX: number, uiY: number) {
    const n = this.particleNode ?? this.particle?.node;
    if (!n) return;
    const parent = n.parent;
    const parentUi = parent?.getComponent(UITransform);
    if (parentUi) {
      // UI location → parent local
      parentUi.convertToNodeSpaceAR(new Vec3(uiX, uiY, 0), this._tmp);
      n.setPosition(this._tmp.x, this._tmp.y, 0);
    } else {
      n.setWorldPosition(uiX, uiY, 0);
    }
  }

  private _centerEmitter() {
    const n = this.particleNode ?? this.particle?.node;
    if (!n) return;
    const visible = view.getVisibleSize();
    this._moveEmitter(visible.width * 0.5, visible.height * 0.5);
  }

  private _onMessage = (ev: MessageEvent) => {
    const data = ev.data;
    if (!data || data.type !== 'particle') return;
    void this._handle(data as ParticleLoadMessage | ParticleControlMessage).catch((err) => {
      this._post({
        type: 'particle',
        event: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    });
  };

  private async _handle(msg: ParticleLoadMessage | ParticleControlMessage) {
    const ps = this.particle;
    if (!ps) throw new Error('ParticleSystem2D missing');

    if (msg.cmd === 'follow') {
      this._follow = msg.enabled !== false;
      return;
    }
    if (msg.cmd === 'load') {
      await this._load(msg as ParticleLoadMessage);
      return;
    }
    if (msg.cmd === 'play') {
      ps.resetSystem();
      return;
    }
    if (msg.cmd === 'pause') {
      ps.stopSystem();
      return;
    }
    if (msg.cmd === 'restart') {
      ps.stopSystem();
      ps.resetSystem();
      return;
    }
    if (msg.cmd === 'stop') {
      ps.stopSystem();
    }
  }

  /**
   * Preview path: NEVER assign ps.file from a raw remote plist.
   * Cocos expects ParticleAsset._nativeAsset; remote loadAny often leaves it empty,
   * then custom=true hits `_initTextureWithDictionary(undefined)` → spriteFrameUuid crash.
   * We already have normalized params from HAR extract — use custom + texture instead.
   */
  private async _load(msg: ParticleLoadMessage) {
    const ps = this.particle!;
    this._follow = msg.follow !== false;

    // Enter custom mode first so assigning spriteFrame won't re-enter broken file path
    ps.custom = true;
    ps.file = null;

    if (msg.textureUrl) {
      const sf = await this._loadSpriteFrame(msg.textureUrl);
      ps.spriteFrame = sf;
    }

    if (msg.params && typeof msg.params === 'object') {
      this._applyParams(ps, msg.params);
    }

    // Game worlds often bake absolute sourcePos — wipe for preview / mouse follow
    ps.sourcePos = new Vec2(0, 0);
    this._centerEmitter();

    ps.resetSystem();
    this._post({
      type: 'particle',
      event: 'loaded',
      name: ps.node.name,
      follow: this._follow,
    });
  }

  private _applyParams(ps: ParticleSystem2D, p: Record<string, unknown>) {
    const numKeys = [
      'duration',
      'emissionRate',
      'life',
      'lifeVar',
      'totalParticles',
      'startSize',
      'startSizeVar',
      'endSize',
      'endSizeVar',
      'startSpin',
      'startSpinVar',
      'endSpin',
      'endSpinVar',
      'angle',
      'angleVar',
      'speed',
      'speedVar',
      'tangentialAccel',
      'tangentialAccelVar',
      'radialAccel',
      'radialAccelVar',
      'emitterMode',
      'positionType',
    ] as const;

    for (const k of numKeys) {
      if (typeof p[k] === 'number' && Number.isFinite(p[k] as number)) {
        (ps as unknown as Record<string, number>)[k] = p[k] as number;
      }
    }

    // Plist often omits emissionRate; custom mode keeps 0 → no particles.
    if (!(ps.emissionRate > 0) && ps.life > 0 && ps.totalParticles > 0) {
      ps.emissionRate = ps.totalParticles / ps.life;
    }

    // Blend factors (plist names)
    if (typeof p.blendFuncSource === 'number') {
      (ps as unknown as { srcBlendFactor: number }).srcBlendFactor = p.blendFuncSource as number;
    }
    if (typeof p.blendFuncDestination === 'number') {
      (ps as unknown as { dstBlendFactor: number }).dstBlendFactor = p.blendFuncDestination as number;
    }

    const asVec = (v: unknown): Vec2 | null => {
      if (!v || typeof v !== 'object') return null;
      const o = v as { x?: number; y?: number };
      if (typeof o.x !== 'number' || typeof o.y !== 'number') return null;
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return null;
      return new Vec2(o.x, o.y);
    };
    const g = asVec(p.gravity);
    if (g) ps.gravity = g;
    const pv = asVec(p.posVar);
    if (pv) ps.posVar = pv;
    // intentionally skip sourcePos — preview uses node position + mouse follow

    const asColor = (v: unknown): Color | null => {
      if (!v || typeof v !== 'object') return null;
      const o = v as { r?: number; g?: number; b?: number; a?: number };
      return new Color(o.r ?? 255, o.g ?? 255, o.b ?? 255, o.a ?? 255);
    };
    const sc = asColor(p.startColor);
    if (sc) ps.startColor = sc;
    const scv = asColor(p.startColorVar);
    if (scv) ps.startColorVar = scv;
    const ec = asColor(p.endColor);
    if (ec) ps.endColor = ec;
    const ecv = asColor(p.endColorVar);
    if (ecv) ps.endColorVar = ecv;

    if (typeof p.playOnAwake === 'boolean') ps.playOnAwake = p.playOnAwake;
    if (typeof p.autoRemoveOnFinish === 'boolean') ps.autoRemoveOnFinish = p.autoRemoveOnFinish;
  }

  private _imageToSpriteFrame(img: ImageAsset): SpriteFrame {
    const tex = new Texture2D();
    tex.image = img;
    const sf = new SpriteFrame();
    sf.texture = tex;
    return sf;
  }

  private _loadSpriteFrame(url: string): Promise<SpriteFrame> {
    return new Promise((resolve, reject) => {
      // Guess ext from URL (png/webp/jpg)
      const m = url.match(/\.(png|jpg|jpeg|webp)(\?|$)/i);
      const ext = m ? `.${m[1].toLowerCase()}` : '.png';
      assetManager.loadRemote<ImageAsset>(url, { ext }, (err, asset) => {
        if (!err && asset instanceof ImageAsset) {
          resolve(this._imageToSpriteFrame(asset));
          return;
        }
        if (!err && asset instanceof SpriteFrame) {
          resolve(asset);
          return;
        }
        assetManager.loadAny({ url, ext }, (e2, img) => {
          if (e2 || !img) {
            reject(err || e2 || new Error(`texture load failed: ${url}`));
            return;
          }
          if (img instanceof SpriteFrame) {
            resolve(img);
            return;
          }
          if (img instanceof ImageAsset) {
            resolve(this._imageToSpriteFrame(img));
            return;
          }
          reject(new Error(`unexpected texture asset: ${url}`));
        });
      });
    });
  }

  private _post(payload: Record<string, unknown>) {
    try {
      if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
        window.parent.postMessage(payload, '*');
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line no-console
    console.log('[ParticlePlayerHost]', payload);
  }
}
