/**
 * dsh-compact-agents 的浏览器 half：设置页「插件 → 可配置」里的一张卡片。
 *
 * 为什么是「一个手写 JS 文件」而不是 npm 包 + 打包器：
 * DSH 的客户端 bundle 只有一条格式约定 —— 一段普通 JS，执行时向
 * `window.__ModuleLoader__` 注册一个工厂 `{ id, factory }`；工厂拿到注入的 `require`，
 * 用它解析**平台种子模块**（白名单见 packages/client/web/src/seed.ts），其余协作一律
 * 走 cordis 服务（ctx.*）。于是本文件：
 *   1. 手写、可读、零构建：不引入打包器、不新增依赖，因此也不写 JSX，改用
 *      `React.createElement`（文件内 `h` 简写）；
 *   2. 只 require 种子模块 `react` 与 `@deepseek-ai/dsh-client-store`。设置命名空间
 *      的读写通道是服务 `ctx.settingsScope`（由 @deepseek-ai/dsh-client-ui-settings 提供），
 *      通过 ctx 取用而不是 require，所以本 bundle 不需要任何 `dsh.client.external`；
 *      只需 package.json 的 `dsh.client.inject` 声明那一行，保证提供方先到场。
 *   3. 按 settings 命名空间注册卡片：`settings.plugin.item` 是 keyed slot，`key` 就是
 *      命名空间字符串 `compact-agents`，标签页据此把宿主 half 注册的命名空间与本卡片
 *      配对（这正是「站外插件自带客户端 half」被官方支持的接缝）。
 *   4. 卡片任何时候都不抛异常：命名空间未就绪（`status !== 'ready'`）时只渲染一句
 *      「设置尚未就绪」。设置页把多张卡片渲染在同一棵树里，一张卡片抛错会毁掉整页。
 *
 * 表单模型与官方卡片同构（见 packages/client/ui-settings-plugins/src/client/card-form.ts，
 * 那是该包的内部文件、不可 import，故此处手写精简版）：编辑先暂存，点「保存」才写；
 * 「重置」暂存一次清除，保存时调用 `scope.unset` 让字段回到未覆盖状态。判断某个字段
 * 是否被用户覆盖，看的是 `user` 层里**有没有这个键**（presence），而不是比较取值 ——
 * 覆盖值恰好等于默认值也仍然是覆盖。
 *
 * @module dsh-compact-agents/lib/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-compact-agents',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    // 种子模块（平台单例，免声明）。除此之外本文件不 require 任何东西。
    const React = require('react');
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');

    /** React.createElement 简写 —— 没有构建步骤，写不了 JSX。 */
    const h = React.createElement;

    /** 宿主 half 注册的 settings 命名空间；卡片按它配对，两端必须逐字一致。 */
    const NAMESPACE = 'compact-agents';

    /** 卡片标题。 */
    const TITLE = '压缩与自动续写';

    /** 「立即生效」：动作发生时读配置，改完下一次压缩/续写就是新值。 */
    const TIMING_LIVE = '立即生效';
    /** 其余三项写进 preset 配置，只在会话建立时读取。 */
    const TIMING_NEW_SESSION = '写入 preset 配置，新建会话生效（已在运行的会话不受影响）';

    /**
     * 卡片编辑的五个字段 —— 冻结的接口，字段名/类型/范围由宿主 half 的 settings 段决定。
     * kind: 'boolean' 渲染成勾选框，'int'/'number' 渲染成文本框并在保存前校验范围。
     */
    const FIELDS = [
      {
        field: 'notice',
        kind: 'boolean',
        label: '压缩提示播报',
        hint: '强制压缩完成后，在对话区播报遮蔽节点数与估算 token 数。默认 true。',
        timing: TIMING_LIVE,
      },
      {
        field: 'maxAutoContinues',
        kind: 'int',
        min: 0,
        max: 10,
        label: '自动续写次数上限',
        hint: '回复被输出上限截断时自动续写的次数上限，0 表示关闭自动续写。默认 2，取值范围 0–10 的整数。',
        timing: TIMING_LIVE,
      },
      {
        field: 'thresholdRatio',
        kind: 'number',
        min: 0.05,
        max: 0.95,
        label: '压缩触发阈值比例',
        hint: '上下文占用达到窗口的这个比例时触发压缩（0.2 = 200K tokens 触发）。取值范围 0.05–0.95。',
        timing: TIMING_NEW_SESSION,
      },
      {
        field: 'retainRatio',
        kind: 'number',
        min: 0.01,
        max: 0.5,
        label: '压缩后保留比例',
        hint: '压缩后保留的上下文比例，越小压得越狠。取值范围 0.01–0.5。',
        timing: TIMING_NEW_SESSION,
      },
      {
        field: 'bootstrapMaxTokens',
        kind: 'int',
        min: 1024,
        max: 200000,
        label: '受控阶段输出预算',
        hint: '受控阶段（每次压缩后会重新进入）单次请求的输出 token 预算。取值范围 1024–200000 的整数。',
        timing: TIMING_NEW_SESSION,
      },
    ];

    /** 字段名 → 字段定义。 */
    const FIELD_BY_NAME = new Map(FIELDS.map(spec => [spec.field, spec]));

    /** 未就绪时的兜底快照：所有读取路径都退化成它，渲染仍然安全。 */
    const PENDING_STATE = Object.freeze({
      status: 'loading',
      available: false,
      writable: false,
      dirty: false,
      invalid: false,
      saving: false,
      failed: false,
      fields: Object.freeze({}),
    });

    /**
     * 未就绪文案。`status` 来自 `scope.getSnapshot().status`：
     * loading = 还没读回宿主设置；unavailable = 宿主没暴露这个命名空间（或本次连接
     * 不持久化设置，远端页面可能落到 memory 模式）。
     * @param status - scope 快照的状态。
     * @returns 一句中文提示，永远包含「设置尚未就绪」。
     */
    function statusText(status) {
      if (status === 'loading') return '设置尚未就绪：正在读取宿主设置，读回后会自动刷新。';
      if (status === 'unavailable') return '设置尚未就绪：宿主未提供 compact-agents 设置命名空间（或当前连接不持久化设置）。';
      return '设置尚未就绪。';
    }

    /**
     * 取一层配置里的字段值。只看自有键，并且拒绝数组/原始值这类非配置层输入。
     * @param layer - base 或 user 层。
     * @param field - 字段名。
     * @returns 字段值，或 undefined。
     */
    function readLayer(layer, field) {
      if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) return undefined;
      return Object.hasOwn(layer, field) ? layer[field] : undefined;
    }

    /**
     * 一个字段是否被用户覆盖过 —— presence 判定，不是比值。
     * @param user - scope 快照的 user 层。
     * @param field - 字段名。
     * @returns user 层携带该键则为 true。
     */
    function isOverridden(user, field) {
      return typeof user === 'object' && user !== null && !Array.isArray(user) && Object.hasOwn(user, field);
    }

    /**
     * 取值 → 草稿文本。空串表示「这一层没给值」，渲染成空控件而不是编造一个默认值。
     * @param spec - 字段定义。
     * @param value - 当前生效值或 base 值。
     * @returns 草稿文本。
     */
    function formatField(spec, value) {
      if (spec.kind === 'boolean') return typeof value === 'boolean' ? String(value) : '';
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    }

    /**
     * 草稿文本 → 这次保存要写的动作。
     * @param spec - 字段定义。
     * @param text - 用户正在编辑的文本。
     * @returns `{kind:'set'|'clear'}`；草稿不是该字段接受的取值时返回 undefined（阻止保存）。
     */
    function parseField(spec, text) {
      const trimmed = text.trim();
      if (trimmed === '') return { kind: 'clear' };
      if (spec.kind === 'boolean') {
        if (trimmed === 'true') return { kind: 'set', value: true };
        if (trimmed === 'false') return { kind: 'set', value: false };
        return undefined;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return undefined;
      if (spec.kind === 'int' && !Number.isInteger(parsed)) return undefined;
      if (parsed < spec.min || parsed > spec.max) return undefined;
      return { kind: 'set', value: parsed };
    }

    /** 取值范围文案，拼进非法提示里。 */
    function rangeText(spec) {
      return `${spec.min}–${spec.max}`;
    }

    /**
     * 一张卡片的表单控制器：把 settings scope 的快照折成卡片状态，把用户编辑折成
     * 保存时才落盘的写入。
     *
     * 之所以经过一个快照 store，是因为渲染侧通过 `props.useCompactAgentsCard(selector)`
     * 订阅它 —— scope 与本地草稿都会变，两者一起重建成新的投影。
     */
    class CompactAgentsCardController {
      /**
       * @param scope - `ctx.settingsScope.bind({ namespace: 'compact-agents' })` 的返回值。
       */
      constructor(scope) {
        this.scope = scope;
        /** 字段名 → 暂存的编辑 `{text, clear}`。 */
        this.staged = new Map();
        this.saving = false;
        this.failed = false;
        this.store = createSnapshotStore(this.projection());
        // 宿主那边的文档提交/重连都会推新快照；订阅后重新投影即可。
        this.unsubscribe = typeof scope.subscribe === 'function'
          ? scope.subscribe(() => { this.publish(); })
          : undefined;
      }

      /** 释放订阅（跟随插件 fiber 的生命周期）。 */
      dispose() {
        if (this.unsubscribe !== undefined) this.unsubscribe();
        this.unsubscribe = undefined;
      }

      /**
       * 当前卡片的完整状态。
       * @returns 卡片快照。
       */
      projection() {
        const snapshot = this.scope.getSnapshot();
        const plan = this.plan();
        const fields = {};
        for (const spec of FIELDS) fields[spec.field] = this.fieldState(spec);
        return {
          status: snapshot.status,
          available: snapshot.status === 'ready',
          writable: snapshot.writable === true,
          dirty: plan.length > 0,
          invalid: plan.some(item => item.run === undefined),
          saving: this.saving,
          failed: this.failed,
          fields,
        };
      }

      /**
       * 一个控件要显示的东西。
       * @param spec - 字段定义。
       * @returns 草稿文本、是否覆盖、是否非法。
       */
      fieldState(spec) {
        const staged = this.staged.get(spec.field);
        if (staged === undefined) {
          const snapshot = this.scope.getSnapshot();
          return {
            text: formatField(spec, readLayer(snapshot.value, spec.field)),
            overridden: isOverridden(snapshot.user, spec.field),
            invalid: false,
          };
        }
        // 暂存编辑自己回答「保存后是否留下覆盖」——徽标预览的是这次保存，而不是一个
        // 已经被待保存编辑推翻的现状。
        const write = staged.clear ? { kind: 'clear' } : parseField(spec, staged.text);
        return {
          text: staged.text,
          overridden: write !== undefined && write.kind === 'set',
          invalid: write === undefined,
        };
      }

      /**
       * 这次保存会执行的写入。草稿非法时不带写入 —— 表单仍然是脏的，保存拒绝执行，
       * 而不是悄悄丢掉这次编辑。
       * @returns 待执行项，`run === undefined` 表示该字段非法、阻塞保存。
       */
      plan() {
        const snapshot = this.scope.getSnapshot();
        const plan = [];
        for (const [field, staged] of this.staged) {
          const spec = FIELD_BY_NAME.get(field);
          if (spec === undefined) continue;
          if (staged.clear) {
            if (isOverridden(snapshot.user, field)) plan.push({ field, run: () => this.clear(field) });
            continue;
          }
          if (staged.text === formatField(spec, readLayer(snapshot.value, field))) continue;
          const write = parseField(spec, staged.text);
          if (write === undefined) plan.push({ field, run: undefined });
          else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) });
          else plan.push({ field, run: () => this.writeField(field, write.value) });
        }
        return plan;
      }

      /**
       * 暂存一次编辑并立即重新投影（不写盘）。
       * @param field - 字段名。
       * @param edit - `{text, clear}`。
       */
      stage(field, edit) {
        this.staged.set(field, edit);
        this.failed = false;
        this.publish();
      }

      /** 渲染侧注入的动作面。 */
      actions() {
        return {
          edit: (field, text) => { this.stage(field, { text, clear: false }); },
          resetField: (field) => {
            const spec = FIELD_BY_NAME.get(field);
            if (spec === undefined) return;
            const snapshot = this.scope.getSnapshot();
            const base = readLayer(snapshot.base, field);
            // 宿主声明了 base 就显示 base；没声明时保留当前生效值，只是标记为「清除」，
            // 免得用户点完重置看到一片空白却不知道原来是什么。
            const text = base === undefined
              ? formatField(spec, readLayer(snapshot.value, field))
              : formatField(spec, base);
            this.stage(field, { text, clear: true });
          },
          save: () => this.save(),
          discard: () => {
            if (this.staged.size === 0 && !this.failed) return;
            this.staged.clear();
            this.failed = false;
            this.publish();
          },
        };
      }

      /**
       * 写入每一处暂存编辑，然后按宿主接受的结果重新播种。
       *
       * 宿主才是「值是否被接受」的唯一权威（范围之外的约束归它的校验器），所以结果从
       * 快照读回而不是在这里预测。没落盘的保存保留草稿，用户可以改而不是重打。
       * @returns 全部写入与读回之后的结算。
       */
      async save() {
        const plan = this.plan();
        if (plan.length === 0 || this.saving || plan.some(item => item.run === undefined)) return;
        this.saving = true;
        this.failed = false;
        this.publish();
        let landed = true;
        for (const item of plan) {
          try {
            landed = (await item.run()) && landed;
          } catch (_writeFailure) {
            // 写失败不是本卡片的崩溃：标记失败、保住草稿，等用户重试。
            landed = false;
          }
        }
        if (landed) this.staged.clear();
        this.saving = false;
        this.failed = !landed;
        this.publish();
      }

      /**
       * 清除一个字段的覆盖层。
       * @param field - 字段名。
       * @returns 清除后该字段是否确实不再出现在 user 层。
       */
      async clear(field) {
        await this.scope.unset(field);
        return !isOverridden(this.scope.getSnapshot().user, field);
      }

      /**
       * 写入一个字段。
       *
       * 名字刻意不叫 `store`：实例上已经有一个快照 store 字段 `this.store`，
       * 同名方法会被实例属性遮蔽，调用时抛 "not a function"。
       * @param field - 字段名。
       * @param value - 用户选定的取值。
       * @returns 写完后 user 层是否确实携带该字段。
       */
      async writeField(field, value) {
        await this.scope.set(field, value);
        return isOverridden(this.scope.getSnapshot().user, field);
      }

      /** 重建投影并推给订阅者。 */
      publish() {
        this.store.set(this.projection());
      }

      /**
       * 构造 slot 注册用的注入面：`hooks` 会被渲染器折成 `useCompactAgentsCard`，
       * 其余成员原样作为 props 递给卡片组件。
       * @returns 卡片的注入面。
       */
      inject() {
        return { hooks: { compactAgentsCard: this.store }, ...this.actions() };
      }
    }

    // ---------------------------------------------------------------------
    // 样式：跟随设置页的 DSH CSS 变量，注入一个带 data-plugin-css 标记的 <style>，
    // 与官方插件的产物同一套约定（Node 下无 document，直接跳过）。
    // ---------------------------------------------------------------------
    const STYLE_ID = 'dsh-compact-agents/card.css';
    const CSS = [
      '.dsh-ca-card{display:flex;flex-direction:column;gap:2px}',
      '.dsh-ca-title{margin:0 0 4px;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-ca-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
      '.dsh-ca-head{align-items:center;gap:8px;display:flex}',
      '.dsh-ca-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-ca-reset{font:inherit;font-size:12px;line-height:1.5;padding:0;border:none;background:0 0;cursor:pointer;color:var(--dsw-alias-label-secondary,#646a73)}',
      '.dsh-ca-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-ca-reset:disabled{cursor:default;color:var(--dsw-alias-label-tertiary,#a3a8b0)}',
      '.dsh-ca-input{height:34px;padding:0 12px;font:inherit;font-size:13px;line-height:1.5;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.15));background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-ca-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#3370ff)}',
      '.dsh-ca-input:disabled{color:var(--dsw-alias-label-tertiary,#a3a8b0);cursor:default}',
      '.dsh-ca-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary,#3370ff)}',
      '.dsh-ca-hint,.dsh-ca-timing,.dsh-ca-pending,.dsh-ca-error,.dsh-ca-note{margin:0;font-size:12px;line-height:1.5}',
      '.dsh-ca-hint{color:var(--dsw-alias-label-tertiary,#a3a8b0)}',
      '.dsh-ca-timing{color:var(--dsw-alias-label-secondary,#646a73)}',
      '.dsh-ca-pending,.dsh-ca-note{color:var(--dsw-alias-label-secondary,#646a73)}',
      '.dsh-ca-error{color:var(--dsw-alias-label-error,#d83931)}',
      '.dsh-ca-actions{display:flex;gap:8px;align-items:center;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
      '.dsh-ca-button{font:inherit;font-size:13px;line-height:1.5;height:32px;padding:0 16px;border-radius:8px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.15));background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-ca-button:disabled{cursor:default;color:var(--dsw-alias-label-tertiary,#a3a8b0)}',
      '.dsh-ca-button-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#3370ff);color:#fff}',
      '.dsh-ca-button-primary:disabled{border-color:transparent;background:var(--dsw-alias-brand-primary-disabled,#bbd0ff)}',
    ].join('');

    /**
     * 幂等地把卡片样式挂进 <head>。
     *
     * 刻意**不打** `data-plugin`：DSH 的模块系统在工厂执行完之后跑 claimStyles，
     * 把所有还没有 data-plugin 的 <style> 认领给本次物化的插件（HMR 失效时会连同
     * 一起移除）。重复物化时靠上一轮被认领的 `data-plugin-css` 命中，不会叠标签。
     * Node 下没有 document，整个函数直接跳过。
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']';
      if (document.querySelector(selector) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * 卡片组件：无内部 state 的纯函数组件（状态全来自控件的快照 store），
     * 因此 renderToStaticMarkup 也能直接渲染它 —— Node 层测试就是这么验证的。
     * @param props - 渲染器绑定的注入面（hooks 已折成 `useCompactAgentsCard`）+ 表单动作。
     * @returns 卡片元素。
     */
    function CompactAgentsCard(props) {
      const face = props ?? {};
      const useCard = face.useCompactAgentsCard;
      let state = PENDING_STATE;
      try {
        if (typeof useCard === 'function') state = useCard(snapshot => snapshot) ?? PENDING_STATE;
      } catch (_readFailure) {
        // 读快照失败退化成「未就绪」：卡片宁可什么都没显示，也不能把设置页带崩。
        state = PENDING_STATE;
      }

      const children = [h('h3', { className: 'dsh-ca-title', key: 'title' }, TITLE)];
      if (state.available !== true) {
        children.push(h('p', { className: 'dsh-ca-pending', key: 'pending' }, statusText(state.status)));
        return h('section', { className: 'dsh-ca-card' }, children);
      }

      const fields = state.fields ?? {};
      const disabled = state.writable !== true;
      for (const spec of FIELDS) {
        const field = fields[spec.field] ?? { text: '', overridden: false, invalid: false };
        const id = `dsh-compact-agents-${spec.field}`;
        const head = [
          h('label', { className: 'dsh-ca-label', htmlFor: id, key: 'label' }, spec.label),
          field.overridden
            ? h('button', {
              className: 'dsh-ca-reset',
              type: 'button',
              key: 'reset',
              disabled,
              onClick: () => { face.resetField(spec.field); },
            }, '重置')
            : null,
        ];
        const control = spec.kind === 'boolean'
          ? h('input', {
            className: 'dsh-ca-check',
            id,
            key: 'control',
            type: 'checkbox',
            checked: field.text === 'true',
            disabled,
            onChange: event => { face.edit(spec.field, event.target.checked ? 'true' : 'false'); },
          })
          : h('input', {
            className: 'dsh-ca-input',
            id,
            key: 'control',
            type: 'text',
            inputMode: spec.kind === 'int' ? 'numeric' : 'decimal',
            value: field.text,
            disabled,
            onChange: event => { face.edit(spec.field, event.target.value); },
          });
        children.push(h('div', { className: 'dsh-ca-field', key: spec.field }, [
          h('div', { className: 'dsh-ca-head', key: 'head' }, head),
          control,
          h('p', { className: 'dsh-ca-hint', key: 'hint' },
            field.invalid ? `取值不合法：本字段接受 ${rangeText(spec)}。` : spec.hint),
          h('p', { className: 'dsh-ca-timing', key: 'timing' }, `生效时机：${spec.timing}`),
        ]));
      }

      const messages = [];
      if (state.invalid) {
        messages.push(h('p', { className: 'dsh-ca-error', key: 'invalid' },
          '有字段的取值不在允许范围内，已阻止保存。'));
      } else if (state.failed) {
        messages.push(h('p', { className: 'dsh-ca-error', key: 'failed' },
          '保存未生效：宿主拒绝了这次写入，草稿已保留，请修正后重试。'));
      }
      if (disabled) {
        messages.push(h('p', { className: 'dsh-ca-note', key: 'readonly' }, '当前设置文档只读，卡片已禁用。'));
      }

      children.push(h('div', { className: 'dsh-ca-actions', key: 'actions' }, [
        h('button', {
          className: 'dsh-ca-button dsh-ca-button-primary',
          type: 'button',
          key: 'save',
          disabled: disabled || state.saving === true || state.dirty !== true || state.invalid === true,
          onClick: () => { face.save(); },
        }, state.saving === true ? '保存中…' : '保存'),
        h('button', {
          className: 'dsh-ca-button',
          type: 'button',
          key: 'discard',
          disabled: disabled || state.dirty !== true || state.saving === true,
          onClick: () => { face.discard(); },
        }, '放弃修改'),
      ]));
      for (const message of messages) children.push(message);
      return h('section', { className: 'dsh-ca-card' }, children);
    }

    /**
     * 挂载卡片。
     * @param ctx - 浏览器插件上下文（`inject` 保证 slots 与 settingsScope 已就绪）。
     */
    function apply(ctx) {
      // 绑定落在调用者 fiber 的生命周期上：插件卸载时 scope 自己会释放。
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      const card = new CompactAgentsCardController(scope);
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => { card.dispose(); }, 'dsh-compact-agents: settings card scope');
      }
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        // keyed slot 的注册键就是 settings 命名空间；标签页按它配对宿主 half。
        key: NAMESPACE,
        inject: () => card.inject(),
      }, CompactAgentsCard));
    }

    /** 需要的 cordis 服务：slots 提供卡片槽位，settingsScope 提供命名空间读写通道。 */
    const inject = ['slots', 'settingsScope'];

    // 样式必须在工厂执行期间挂上，模块系统随后就会认领它（见 ensureStyle）。
    ensureStyle();

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
