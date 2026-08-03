System.register("chunks:///_virtual/main", ['./ParticlePlayerHost.ts'], function () {
  return {
    setters: [null],
    execute: function () {}
  };
});

System.register("chunks:///_virtual/ParticlePlayerHost.ts", ['./rollupPluginModLoBabelHelpers.js', 'cc'], function (exports) {
  var _applyDecoratedDescriptor, _inheritsLoose, _initializerDefineProperty, _assertThisInitialized, _asyncToGenerator, _regeneratorRuntime, cclegacy, _decorator, ParticleSystem2D, Node, find, Camera, input, Input, UITransform, Vec3, view, Texture2D, SpriteFrame, assetManager, ImageAsset, Vec2, Color, Component;
  return {
    setters: [function (module) {
      _applyDecoratedDescriptor = module.applyDecoratedDescriptor;
      _inheritsLoose = module.inheritsLoose;
      _initializerDefineProperty = module.initializerDefineProperty;
      _assertThisInitialized = module.assertThisInitialized;
      _asyncToGenerator = module.asyncToGenerator;
      _regeneratorRuntime = module.regeneratorRuntime;
    }, function (module) {
      cclegacy = module.cclegacy;
      _decorator = module._decorator;
      ParticleSystem2D = module.ParticleSystem2D;
      Node = module.Node;
      find = module.find;
      Camera = module.Camera;
      input = module.input;
      Input = module.Input;
      UITransform = module.UITransform;
      Vec3 = module.Vec3;
      view = module.view;
      Texture2D = module.Texture2D;
      SpriteFrame = module.SpriteFrame;
      assetManager = module.assetManager;
      ImageAsset = module.ImageAsset;
      Vec2 = module.Vec2;
      Color = module.Color;
      Component = module.Component;
    }],
    execute: function () {
      var _dec, _dec2, _dec3, _class, _class2, _descriptor, _descriptor2;
      cclegacy._RF.push({}, "ed811LwLbBJCqSjwD39GcSC", "ParticlePlayerHost", undefined);
      var ccclass = _decorator.ccclass,
        property = _decorator.property;
      /**
       * iframe / parent postMessage bridge for harExplore particle preview.
       */
      var ParticlePlayerHost = exports('ParticlePlayerHost', (_dec = ccclass('ParticlePlayerHost'), _dec2 = property(ParticleSystem2D), _dec3 = property(Node), _dec(_class = (_class2 = /*#__PURE__*/function (_Component) {
        _inheritsLoose(ParticlePlayerHost, _Component);
        function ParticlePlayerHost() {
          var _this;
          for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
            args[_key] = arguments[_key];
          }
          _this = _Component.call.apply(_Component, [this].concat(args)) || this;
          _initializerDefineProperty(_this, "particle", _descriptor, _assertThisInitialized(_this));
          _initializerDefineProperty(_this, "particleNode", _descriptor2, _assertThisInitialized(_this));
          _this._follow = true;
          _this._uiCamera = null;
          _this._tmp = new Vec3();
          _this._bindMessage = function () {
            if (typeof window === 'undefined') return;
            window.addEventListener('message', _this._onMessage);
          };
          _this._onMouseMove = function (ev) {
            if (!_this._follow) return;
            var loc = ev.getUILocation();
            _this._moveEmitter(loc.x, loc.y);
          };
          _this._onTouchMove = function (ev) {
            if (!_this._follow) return;
            var loc = ev.getUILocation();
            _this._moveEmitter(loc.x, loc.y);
          };
          _this._onMessage = function (ev) {
            var data = ev.data;
            if (!data || data.type !== 'particle') return;
            void _this._handle(data)["catch"](function (err) {
              _this._post({
                type: 'particle',
                event: 'error',
                message: err instanceof Error ? err.message : String(err)
              });
            });
          };
          return _this;
        }
        var _proto = ParticlePlayerHost.prototype;
        _proto.onLoad = function onLoad() {
          var _ref2, _find$getComponent, _find, _this$node$scene;
          if (!this.particle) {
            var _ref, _this$particleNode;
            var n = (_ref = (_this$particleNode = this.particleNode) != null ? _this$particleNode : this.node.getChildByName('Particle')) != null ? _ref : this.node;
            this.particle = n.getComponent(ParticleSystem2D);
            if (!this.particleNode) this.particleNode = n;
          }
          this._uiCamera = (_ref2 = (_find$getComponent = (_find = find('Canvas/Camera')) == null ? void 0 : _find.getComponent(Camera)) != null ? _find$getComponent : (_this$node$scene = this.node.scene) == null ? void 0 : _this$node$scene.getComponentInChildren(Camera)) != null ? _ref2 : null;
          this._bindMessage();
          this._bindPointer();
          this._post({
            type: 'particle',
            event: 'ready'
          });
        };
        _proto.onDestroy = function onDestroy() {
          if (typeof window !== 'undefined') {
            window.removeEventListener('message', this._onMessage);
          }
          input.off(Input.EventType.MOUSE_MOVE, this._onMouseMove, this);
          input.off(Input.EventType.TOUCH_MOVE, this._onTouchMove, this);
        };
        _proto._bindPointer = function _bindPointer() {
          input.on(Input.EventType.MOUSE_MOVE, this._onMouseMove, this);
          input.on(Input.EventType.TOUCH_MOVE, this._onTouchMove, this);
        };
        _proto._moveEmitter = function _moveEmitter(uiX, uiY) {
          var _this$particleNode2, _this$particle;
          var n = (_this$particleNode2 = this.particleNode) != null ? _this$particleNode2 : (_this$particle = this.particle) == null ? void 0 : _this$particle.node;
          if (!n) return;
          var parent = n.parent;
          var parentUi = parent == null ? void 0 : parent.getComponent(UITransform);
          if (parentUi) {
            // UI location → parent local
            parentUi.convertToNodeSpaceAR(new Vec3(uiX, uiY, 0), this._tmp);
            n.setPosition(this._tmp.x, this._tmp.y, 0);
          } else {
            n.setWorldPosition(uiX, uiY, 0);
          }
        };
        _proto._centerEmitter = function _centerEmitter() {
          var _this$particleNode3, _this$particle2;
          var n = (_this$particleNode3 = this.particleNode) != null ? _this$particleNode3 : (_this$particle2 = this.particle) == null ? void 0 : _this$particle2.node;
          if (!n) return;
          var visible = view.getVisibleSize();
          this._moveEmitter(visible.width * 0.5, visible.height * 0.5);
        };
        _proto._handle = /*#__PURE__*/function () {
          var _handle2 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee(msg) {
            var ps;
            return _regeneratorRuntime().wrap(function _callee$(_context) {
              while (1) switch (_context.prev = _context.next) {
                case 0:
                  ps = this.particle;
                  if (ps) {
                    _context.next = 3;
                    break;
                  }
                  throw new Error('ParticleSystem2D missing');
                case 3:
                  if (!(msg.cmd === 'follow')) {
                    _context.next = 6;
                    break;
                  }
                  this._follow = msg.enabled !== false;
                  return _context.abrupt("return");
                case 6:
                  if (!(msg.cmd === 'load')) {
                    _context.next = 10;
                    break;
                  }
                  _context.next = 9;
                  return this._load(msg);
                case 9:
                  return _context.abrupt("return");
                case 10:
                  if (!(msg.cmd === 'play')) {
                    _context.next = 13;
                    break;
                  }
                  ps.resetSystem();
                  return _context.abrupt("return");
                case 13:
                  if (!(msg.cmd === 'pause')) {
                    _context.next = 16;
                    break;
                  }
                  ps.stopSystem();
                  return _context.abrupt("return");
                case 16:
                  if (!(msg.cmd === 'restart')) {
                    _context.next = 20;
                    break;
                  }
                  ps.stopSystem();
                  ps.resetSystem();
                  return _context.abrupt("return");
                case 20:
                  if (msg.cmd === 'stop') {
                    ps.stopSystem();
                  }
                case 21:
                case "end":
                  return _context.stop();
              }
            }, _callee, this);
          }));
          function _handle(_x) {
            return _handle2.apply(this, arguments);
          }
          return _handle;
        }()
        /**
         * Preview path: NEVER assign ps.file from a raw remote plist.
         * Cocos expects ParticleAsset._nativeAsset; remote loadAny often leaves it empty,
         * then custom=true hits `_initTextureWithDictionary(undefined)` → spriteFrameUuid crash.
         * We already have normalized params from HAR extract — use custom + texture instead.
         */;

        _proto._load = /*#__PURE__*/
        function () {
          var _load2 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee2(msg) {
            var ps, sf;
            return _regeneratorRuntime().wrap(function _callee2$(_context2) {
              while (1) switch (_context2.prev = _context2.next) {
                case 0:
                  ps = this.particle;
                  this._follow = msg.follow !== false;

                  // Enter custom mode first so assigning spriteFrame won't re-enter broken file path
                  ps.custom = true;
                  ps.file = null;
                  if (!msg.textureUrl) {
                    _context2.next = 9;
                    break;
                  }
                  _context2.next = 7;
                  return this._loadSpriteFrame(msg.textureUrl);
                case 7:
                  sf = _context2.sent;
                  ps.spriteFrame = sf;
                case 9:
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
                    follow: this._follow
                  });
                case 14:
                case "end":
                  return _context2.stop();
              }
            }, _callee2, this);
          }));
          function _load(_x2) {
            return _load2.apply(this, arguments);
          }
          return _load;
        }();
        _proto._applyParams = function _applyParams(ps, p) {
          var numKeys = ['duration', 'emissionRate', 'life', 'lifeVar', 'totalParticles', 'startSize', 'startSizeVar', 'endSize', 'endSizeVar', 'startSpin', 'startSpinVar', 'endSpin', 'endSpinVar', 'angle', 'angleVar', 'speed', 'speedVar', 'tangentialAccel', 'tangentialAccelVar', 'radialAccel', 'radialAccelVar', 'emitterMode', 'positionType'];
          for (var _i = 0, _numKeys = numKeys; _i < _numKeys.length; _i++) {
            var k = _numKeys[_i];
            if (typeof p[k] === 'number' && Number.isFinite(p[k])) {
              ps[k] = p[k];
            }
          }

          // Plist often omits emissionRate; custom mode keeps 0 → no particles.
          if (!(ps.emissionRate > 0) && ps.life > 0 && ps.totalParticles > 0) {
            ps.emissionRate = ps.totalParticles / ps.life;
          }

          // Blend factors (plist names)
          if (typeof p.blendFuncSource === 'number') {
            ps.srcBlendFactor = p.blendFuncSource;
          }
          if (typeof p.blendFuncDestination === 'number') {
            ps.dstBlendFactor = p.blendFuncDestination;
          }
          var asVec = function asVec(v) {
            if (!v || typeof v !== 'object') return null;
            var o = v;
            if (typeof o.x !== 'number' || typeof o.y !== 'number') return null;
            if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return null;
            return new Vec2(o.x, o.y);
          };
          var g = asVec(p.gravity);
          if (g) ps.gravity = g;
          var pv = asVec(p.posVar);
          if (pv) ps.posVar = pv;
          // intentionally skip sourcePos — preview uses node position + mouse follow

          var asColor = function asColor(v) {
            var _o$r, _o$g, _o$b, _o$a;
            if (!v || typeof v !== 'object') return null;
            var o = v;
            return new Color((_o$r = o.r) != null ? _o$r : 255, (_o$g = o.g) != null ? _o$g : 255, (_o$b = o.b) != null ? _o$b : 255, (_o$a = o.a) != null ? _o$a : 255);
          };
          var sc = asColor(p.startColor);
          if (sc) ps.startColor = sc;
          var scv = asColor(p.startColorVar);
          if (scv) ps.startColorVar = scv;
          var ec = asColor(p.endColor);
          if (ec) ps.endColor = ec;
          var ecv = asColor(p.endColorVar);
          if (ecv) ps.endColorVar = ecv;
          if (typeof p.playOnAwake === 'boolean') ps.playOnAwake = p.playOnAwake;
          if (typeof p.autoRemoveOnFinish === 'boolean') ps.autoRemoveOnFinish = p.autoRemoveOnFinish;
        };
        _proto._imageToSpriteFrame = function _imageToSpriteFrame(img) {
          var tex = new Texture2D();
          tex.image = img;
          var sf = new SpriteFrame();
          sf.texture = tex;
          return sf;
        };
        _proto._loadSpriteFrame = function _loadSpriteFrame(url) {
          var _this2 = this;
          return new Promise(function (resolve, reject) {
            // Guess ext from URL (png/webp/jpg)
            var m = url.match(/\.(png|jpg|jpeg|webp)(\?|$)/i);
            var ext = m ? "." + m[1].toLowerCase() : '.png';
            assetManager.loadRemote(url, {
              ext: ext
            }, function (err, asset) {
              if (!err && asset instanceof ImageAsset) {
                resolve(_this2._imageToSpriteFrame(asset));
                return;
              }
              if (!err && asset instanceof SpriteFrame) {
                resolve(asset);
                return;
              }
              assetManager.loadAny({
                url: url,
                ext: ext
              }, function (e2, img) {
                if (e2 || !img) {
                  reject(err || e2 || new Error("texture load failed: " + url));
                  return;
                }
                if (img instanceof SpriteFrame) {
                  resolve(img);
                  return;
                }
                if (img instanceof ImageAsset) {
                  resolve(_this2._imageToSpriteFrame(img));
                  return;
                }
                reject(new Error("unexpected texture asset: " + url));
              });
            });
          });
        };
        _proto._post = function _post(payload) {
          try {
            if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
              window.parent.postMessage(payload, '*');
            }
          } catch (_unused) {
            /* ignore */
          }
          // eslint-disable-next-line no-console
          console.log('[ParticlePlayerHost]', payload);
        };
        return ParticlePlayerHost;
      }(Component), (_descriptor = _applyDecoratedDescriptor(_class2.prototype, "particle", [_dec2], {
        configurable: true,
        enumerable: true,
        writable: true,
        initializer: function initializer() {
          return null;
        }
      }), _descriptor2 = _applyDecoratedDescriptor(_class2.prototype, "particleNode", [_dec3], {
        configurable: true,
        enumerable: true,
        writable: true,
        initializer: function initializer() {
          return null;
        }
      })), _class2)) || _class));
      cclegacy._RF.pop();
    }
  };
});

(function(r) {
  r('virtual:///prerequisite-imports/main', 'chunks:///_virtual/main'); 
})(function(mid, cid) {
    System.register(mid, [cid], function (_export, _context) {
    return {
        setters: [function(_m) {
            var _exportObj = {};

            for (var _key in _m) {
              if (_key !== "default" && _key !== "__esModule") _exportObj[_key] = _m[_key];
            }
      
            _export(_exportObj);
        }],
        execute: function () { }
    };
    });
});