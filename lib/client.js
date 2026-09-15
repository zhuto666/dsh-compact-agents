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
 *   2. 只 require 种子模块 `react`、`@deepseek-ai/dsh-client-store` 与
 *      `@deepseek-ai/dsh-client-ui-primitives`。后者的 `Tag`（只读胶囊徽标）与
 *      `IconChevronDownOutline14`（头部箭头）正是官方 PluginCard 用的那两个原子，
 *      「原生观感」由此而来。设置命名空间的读写通道是服务 `ctx.settingsScope`
 *      （由 @deepseek-ai/dsh-client-ui-settings 提供），通过 ctx 取用而不是 require，
 *      所以本 bundle 不需要任何 `dsh.client.external`；只需 package.json 的
 *      `dsh.client.inject` 声明那一行，保证提供方先到场。
 *   3. 按 settings 命名空间注册卡片：`settings.plugin.item` 是 keyed slot，`key` 就是
 *      命名空间字符串 `compact-agents`，标签页据此把宿主 half 注册的命名空间与本卡片
 *      配对（这正是「站外插件自带客户端 half」被官方支持的接缝）。
 *   4. 卡片任何时候都不抛异常：命名空间未就绪（`status !== 'ready'`）时只渲染一句
 *      「设置尚未就绪」。设置页把多张卡片渲染在同一棵树里，一张卡片抛错会毁掉整页。
 *   5. 卡片外壳照抄官方 `ui-settings-plugins` 的 PluginCard.tsx + PluginCard.module.css
 *      （那两个文件不可 import，故手写同构版）：折叠头部（标题压描述 + 「未保存」徽标 +
 *      箭头）、展开后按生效时机分组的紧凑字段行、末尾「放弃修改 / 保存」动作条，
 *      保存成功后自动收起。字段行本身对应官方的 fields.tsx `ValueField`，只是把
 *      标签与控件收进同一行，只留一行 hint 小字。
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

    /** 卡片内部的折叠状态用的三个 hook（官方 PluginCard 同样把开合放在组件里）。 */
    const { useState, useRef, useEffect } = React;

    /**
     * 官方 UI 原子。`Tag` 是只读胶囊徽标，`IconChevronDownOutline14` 是折叠箭头 ——
     * 与官方 PluginCard 用的是同一对组件，观感天然一致，不用自己画胶囊和箭头。
     * 万一种子模块缺席（平台版本较旧），退化成等价的本地实现：卡片宁可样式朴素，
     * 也不能因为一次 require 失败把整页设置带崩。
     */
    let primitives = {};
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') ?? {};
    } catch (_noPrimitives) {
      primitives = {};
    }
    const Tag = typeof primitives.Tag === 'function'
      ? primitives.Tag
      : function Tag(props) {
        return h('span', {
          className: props.className === undefined ? 'dsh-ca-tag' : `dsh-ca-tag ${props.className}`,
          'data-tone': props.tone ?? 'outline',
        }, props.children);
      };
    const Chevron = typeof primitives.IconChevronDownOutline14 === 'function'
      ? primitives.IconChevronDownOutline14
      : function IconChevronDownOutline14(props) {
        return h('span', { className: props.className, 'aria-hidden': 'true' }, '▾');
      };

    /** 宿主 half 注册的 settings 命名空间；卡片按它配对，两端必须逐字一致。 */
    const NAMESPACE = 'compact-agents';

    /** 卡片标题。 */
    const TITLE = '压缩与自动续写';

    /** 卡片总说明：与官方卡片一样，标题下压一行描述，正文里不再重复。 */
    const DESCRIPTION = '强制压缩的触发阈值、保留比例与输出预算，以及自动续写次数。';

    /**
     * 三种生效时机 —— 字段按它分组渲染，每组的题注就是时机名 + 一句补充说明。
     * 于是「哪些改动立刻生效、哪些要等新建会话」只占三行小字，而不是每个字段各写一段；
     * 组内每个字段只有「标签 + 控件 + 一行 hint」。
     */
    const TIERS = [
      { id: 'live', name: '立即生效', note: '动作发生时读取，改完下一次压缩或续写即生效。' },
      { id: 'hot', name: '写入预设并热同步', note: '写进预设配置，同时热同步给正在运行的会话，下一次步边界即生效。' },
      { id: 'preset', name: '新建会话生效', note: '写进预设配置，只在新会话读取，已在运行的会话不受影响。' },
    ];

    /**
     * 卡片编辑的五个字段 —— 冻结的接口，字段名/类型/范围由宿主 half 的 settings 段决定。
     * kind 决定保存前的校验（'boolean' 只收 true/false，'int' 收整数，'number' 收数值），
     * tier 决定分组：live 两项宿主每次动作都读；hot 两项由本插件热同步进运行中的
     * `compaction-basic`；preset 那一项属于别的插件、只能等新会话。
     * 带 options 的字段渲染成下拉框（有限取值），其余渲染成数字输入框 + 一行 hint。
     */
    const FIELDS = [
      {
        field: 'notice',
        kind: 'boolean',
        tier: 'live',
        options: [
          { value: 'true', label: '开启' },
          { value: 'false', label: '关闭' },
        ],
        label: '压缩提示播报',
        hint: '压缩完成后播报遮蔽节点数与估算 token 数，默认开启。',
      },
      {
        field: 'maxAutoContinues',
        kind: 'int',
        min: 0,
        max: 10,
        tier: 'live',
        // 常见档位，避免手打数字；当前值不在这几个档位时仍会原样列出（见 selectOptions）。
        options: [0, 1, 2, 3, 5, 10].map(count => ({ value: String(count), label: String(count) })),
        label: '自动续写次数上限',
        hint: '回复被输出上限截断时自动续写的次数上限，0 表示关闭，默认 2。',
      },
      {
        field: 'thresholdRatio',
        kind: 'number',
        min: 0.05,
        max: 0.95,
        tier: 'hot',
        label: '压缩触发阈值比例',
        hint: '上下文占用达到窗口的这个比例时触发压缩；默认 0.35，即窗口 100 万 tokens 时约在 35 万处触发。',
      },
      {
        field: 'retainRatio',
        kind: 'number',
        min: 0.01,
        max: 0.5,
        tier: 'hot',
        label: '压缩后保留比例',
        hint: '压缩后保留的上下文比例，越小压得越狠；默认 0.05，即窗口 100 万 tokens 时至少留 5 万 tokens 的原文（按整条消息对齐，实际会略多）。',
      },
      {
        field: 'bootstrapMaxTokens',
        kind: 'int',
        min: 1024,
        max: 200000,
        tier: 'preset',
        label: '受控阶段输出预算',
        hint: '受控阶段单次请求的输出 token 预算，取整数。',
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
     * 一行控件的 hover 提示：字段说明 + 取值范围。
     * 生效时机**不**在这里 —— 它由所在分组的题注统一交代（见 TIERS），
     * 免得每个字段都为它多占一行。
     * @param spec - 字段定义。
     * @returns 提示文案。
     */
    function rowTitle(spec) {
      const range = spec.min === undefined ? '' : `取值 ${rangeText(spec)}。`;
      return `${spec.hint}${range}`;
    }

    /**
     * 下拉框要渲染的选项。
     *
     * 有限档位是给用户点的，但当前值可能不在档位表里（宿主默认值、或历史写入的
     * 中间值），这时把当前值补到最前面，免得下拉框显示成一个用户没选过的值。
     * @param spec - 带 options 的字段定义。
     * @param text - 当前草稿文本。
     * @returns `{value,label}` 选项列表。
     */
    function selectOptions(spec, text) {
      const base = spec.options ?? [];
      if (text === '') return [{ value: '', label: '未设置' }].concat(base);
      const known = base.some(option => option.value === text);
      return known ? base : [{ value: text, label: text }].concat(base);
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
    /**
     * 下拉框右侧的内联箭头。官方设置页的 select 变体就是这么做的：去掉系统箭头
     * （它贴着右边框），换成 12px 的同一枚箭头并给它留出右侧内边距。
     * 数据 URI 里的颜色取官方那份的 #81858C（数据 URI 解析不到 CSS 变量）。
     */
    const SELECT_ARROW = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
    const CSS = [
      // 外层：与官方 PluginCard 同一套观感 —— 圆角描边的 li、可折叠的头部（名称 + 描述 + 箭头）。
      '.dsh-ca-card{list-style:none;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.15));border-radius:16px;background:var(--dsw-alias-bg-layer-3,#fff);transition:border-color .16s,background .16s}',
      '.dsh-ca-card:hover{border-color:var(--dsw-alias-label-dimmed,rgba(0,0,0,.4))}',
      '.dsh-ca-card-open{background:var(--dsw-alias-bg-layer-2,#f5f6f7);border-color:var(--dsw-alias-label-dimmed,rgba(0,0,0,.4))}',
      '.dsh-ca-header{display:flex;align-items:center;gap:12px;width:100%;padding:14px 16px;border:0;border-radius:12px;background:0 0;font:inherit;color:inherit;text-align:left;cursor:pointer}',
      '.dsh-ca-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3370ff);outline-offset:-2px}',
      '.dsh-ca-headtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dsh-ca-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-ca-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#a3a8b0)}',
      '.dsh-ca-chevron{flex:none;color:var(--dsw-alias-label-tertiary,#a3a8b0);transition:transform .16s}',
      '.dsh-ca-card-open .dsh-ca-chevron{transform:rotate(180deg)}',
      // 未就绪时卡片只剩这一句小字（不渲染头部、字段与动作条，见组件里的分支）。
      '.dsh-ca-status{margin:0;padding:14px 16px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#a3a8b0)}',
      // 头部右侧的「未保存」徽标：折叠起来也能看出这张卡里有没落盘的编辑。
      // 胶囊的几何与配色来自 Tag 原子，这里只负责它在 flex 行里的位置。
      '.dsh-ca-pending{flex:none}',
      // 种子模块缺席时的兜底 Tag：几何与配色照抄官方 Tag.module.css 的 neutral 调。
      '.dsh-ca-tag{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#646a73)}',
      '.dsh-ca-body{margin:0 16px;padding:2px 0 8px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
      // 字段按生效时机分成两组，组间一条细分隔线；每组开头一行小字交代时机，
      // 组内每个字段是「标签在左、控件在右」的一行 + 一行 hint。
      '.dsh-ca-group{padding:10px 0 4px}',
      '.dsh-ca-group + .dsh-ca-group{border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
      '.dsh-ca-field{padding:2px 0 6px}',
      '.dsh-ca-row{display:flex;align-items:center;gap:8px;padding:6px 0 2px}',
      '.dsh-ca-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2329);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // 分组题注：时机名 + 一句补充说明。两行小字取代了原先每个字段各写一段的「生效时机」。
      '.dsh-ca-grouphead{margin:0 0 2px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#a3a8b0)}',
      '.dsh-ca-reset{flex:none;font:inherit;font-size:12px;line-height:1.5;padding:0;border:none;background:0 0;cursor:pointer;color:var(--dsw-alias-label-secondary,#646a73)}',
      '.dsh-ca-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-ca-reset:disabled{cursor:default;color:var(--dsw-alias-label-tertiary,#a3a8b0)}',
      '.dsh-ca-input{flex:none;width:124px;height:34px;padding:0 12px;font:inherit;font-size:13px;line-height:1.5;text-align:right;font-variant-numeric:tabular-nums;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.15));background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dsh-ca-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#3370ff)}',
      '.dsh-ca-input:disabled{color:var(--dsw-alias-label-tertiary,#a3a8b0);cursor:default}',
      `.dsh-ca-select{flex:none;appearance:none;height:34px;padding:0 32px 0 12px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.15));background-color:var(--dsw-alias-bg-layer-3,#fff);background-image:${SELECT_ARROW};background-repeat:no-repeat;background-position:right 12px center;background-size:12px 12px;color:var(--dsw-alias-label-primary,#1f2329)}`,
      '.dsh-ca-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#3370ff)}',
      '.dsh-ca-select:disabled{color:var(--dsw-alias-label-tertiary,#a3a8b0);cursor:default}',
      // 一行 hint 小字（草稿非法时换成同位置的非法提示），对齐官方 ValueField 的 hint。
      '.dsh-ca-hint,.dsh-ca-invalid{margin:0;font-size:12px;line-height:1.5}',
      '.dsh-ca-hint{color:var(--dsw-alias-label-tertiary,#a3a8b0)}',
      '.dsh-ca-invalid{color:var(--dsw-alias-label-error,#d83931)}',
      '.dsh-ca-note,.dsh-ca-error{margin:0;font-size:12px;line-height:1.5}',
      // 只读提示：照抄官方 PluginCard.module.css 的 .readOnly（12px 弱化色，顶在字段之上）。
      '.dsh-ca-note{margin:12px 0 0;color:var(--dsw-alias-label-tertiary,#a3a8b0)}',
      // 底部动作条：与官方卡片一致 —— 右对齐，失败提示占满左侧，先「放弃修改」后「保存」。
      '.dsh-ca-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
      '.dsh-ca-error{flex:1;min-width:0;color:var(--dsw-alias-label-error,#d83931)}',
      '.dsh-ca-discard,.dsh-ca-save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}',
      '.dsh-ca-discard{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.08));background:0 0;color:var(--dsw-alias-label-secondary,#646a73)}',
      '.dsh-ca-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary,#1f2329);border-color:var(--dsw-alias-label-dimmed,rgba(0,0,0,.4))}',
      '.dsh-ca-save{background:var(--dsw-alias-label-primary,#1f2329);color:var(--dsw-alias-bg-layer-3,#fff)}',
      '.dsh-ca-discard:disabled,.dsh-ca-save:disabled{opacity:.4;cursor:default}',
      '.dsh-ca-discard:focus-visible,.dsh-ca-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3370ff);outline-offset:1px}',
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
     * 一个字段行 —— 官方 fields.tsx `ValueField` 的紧凑版。
     *
     * 官方是「标签一行 / 控件一行 / hint 一行」三段；设置页里每多一行就是每张卡多一截高度，
     * 所以这里把标签与控件收进同一行（标签占满左侧、控件靠右），只保留 hint 那一行小字。
     * 「已覆盖 / 重置」照旧跟着标签走：徽标用 Tag 原子，重置是一个文字按钮。
     * @param spec - 字段定义。
     * @param field - 该字段的草稿状态（text / overridden / invalid）。
     * @param disabled - 设置文档只读时为 true，控件全部禁用。
     * @param face - 卡片的注入面（表单动作）。
     * @returns 字段行元素。
     */
    function fieldRow(spec, field, disabled, face) {
      const id = `dsh-compact-agents-${spec.field}`;
      const row = [h('label', { className: 'dsh-ca-label', htmlFor: id, key: 'label' }, spec.label)];
      if (field.overridden) {
        row.push(h(Tag, { tone: 'neutral', key: 'overridden' }, '已覆盖'));
        row.push(h('button', {
          className: 'dsh-ca-reset',
          type: 'button',
          key: 'reset',
          disabled,
          onClick: () => { face.resetField(spec.field); },
        }, '重置'));
      }
      // 有限取值的字段（notice / maxAutoContinues）用下拉框；连续值仍是文本输入 ——
      // 与官方一致：范围交给 hint 与保存前的校验，不在控件上限制用户能打什么。
      row.push(Array.isArray(spec.options)
        ? h('select', {
          className: 'dsh-ca-select',
          id,
          key: 'control',
          value: field.text,
          disabled,
          onChange: event => { face.edit(spec.field, event.target.value); },
        }, selectOptions(spec, field.text).map(option => h('option', {
          value: option.value,
          key: option.value,
        }, option.label)))
        : h('input', {
          className: 'dsh-ca-input',
          id,
          key: 'control',
          type: 'text',
          inputMode: spec.kind === 'int' ? 'numeric' : 'decimal',
          value: field.text,
          disabled,
          onChange: event => { face.edit(spec.field, event.target.value); },
        }));
      return h('div', { className: 'dsh-ca-field', key: spec.field }, [
        // 整行挂 hint + 取值范围：控件占位有限，说明放在 hover 里，正文不为此多占一行。
        h('div', { className: 'dsh-ca-row', key: 'row', title: rowTitle(spec) }, row),
        h('p', {
          className: field.invalid ? 'dsh-ca-invalid' : 'dsh-ca-hint',
          key: 'hint',
        }, field.invalid ? `取值不合法：本字段接受 ${rangeText(spec)}。` : spec.hint),
      ]);
    }

    /**
     * 卡片组件：把控件快照渲染成官方插件卡那样的折叠卡片。
     *
     * 开合状态放在组件里（与官方 PluginCard 同样的做法），字段数据仍全部来自注入的
     * `useCompactAgentsCard`。本组件自己的三个 hook 先调用、注入的 hook 最后调用，
     * 这样即使读快照抛错退化成「未就绪」，hook 的位置也不会错位。
     * @param props - 渲染器绑定的注入面（hooks 已折成 `useCompactAgentsCard`）+ 表单动作；
     *   另接受可选的 `initiallyOpen`（默认收起，测试用它直接渲染展开态）。
     * @returns 卡片元素。
     */
    function CompactAgentsCard(props) {
      const face = props ?? {};
      const [open, setOpen] = useState(face.initiallyOpen === true);
      const saveStarted = useRef(false);
      const settled = useRef({ dirty: false, failed: false, saving: false });
      // 保存成功后自动收起；被拒绝的保存保持展开，让报错与草稿都留在眼前 ——
      // 与官方 PluginCard 同一套判断（saving / dirty / failed 三个状态一起看）。
      // 这个 effect 刻意不写依赖数组：它每次渲染后都跑，读的是本次渲染刚写进 ref 的状态，
      // 于是它的位置永远排在注入的 hook 之前。
      useEffect(() => {
        const latest = settled.current;
        if (latest.saving) {
          saveStarted.current = true;
          return;
        }
        if (saveStarted.current !== true) return;
        saveStarted.current = false;
        if (!latest.dirty && !latest.failed) setOpen(false);
      });

      let state = PENDING_STATE;
      try {
        if (typeof face.useCompactAgentsCard === 'function') {
          state = face.useCompactAgentsCard(snapshot => snapshot) ?? PENDING_STATE;
        }
      } catch (_readFailure) {
        // 读快照失败退化成「未就绪」：卡片宁可什么都没显示，也不能把设置页带崩。
        state = PENDING_STATE;
      }
      settled.current = {
        dirty: state.dirty === true,
        failed: state.failed === true,
        saving: state.saving === true,
      };

      // 未就绪：只有一句提示 —— 不渲染头部、字段与动作条。
      if (state.available !== true) {
        return h('li', { className: 'dsh-ca-card' },
          h('p', { className: 'dsh-ca-status' }, statusText(state.status)));
      }

      const fields = state.fields ?? {};
      const disabled = state.writable !== true;
      // 头部本身就是按钮：标题压描述、右侧「未保存」徽标 + 箭头，点开才渲染正文。
      const header = h('button', {
        className: 'dsh-ca-header',
        type: 'button',
        key: 'header',
        'aria-expanded': open,
        'aria-label': `${open ? '收起' : '展开'}：${TITLE}`,
        onClick: () => { setOpen(!open); },
      }, [
        h('span', { className: 'dsh-ca-headtext', key: 'text' }, [
          h('span', { className: 'dsh-ca-name', key: 'name' }, TITLE),
          h('span', { className: 'dsh-ca-desc', key: 'desc' }, DESCRIPTION),
        ]),
        state.dirty === true
          ? h(Tag, { tone: 'neutral', className: 'dsh-ca-pending', key: 'pending' }, '未保存')
          : null,
        h(Chevron, { className: 'dsh-ca-chevron', key: 'chevron' }),
      ]);

      const body = [];
      if (disabled) {
        body.push(h('p', { className: 'dsh-ca-note', key: 'readonly', role: 'status' },
          '当前设置文档只读，卡片已禁用。'));
      }
      // 字段按生效时机分组：一组一行小字的题注，代替原先每个字段一句「生效时机」。
      for (const tier of TIERS) {
        const group = [h('p', { className: 'dsh-ca-grouphead', key: 'head' },
          `${tier.name} · ${tier.note}`)];
        for (const spec of FIELDS) {
          if (spec.tier !== tier.id) continue;
          group.push(fieldRow(
            spec,
            fields[spec.field] ?? { text: '', overridden: false, invalid: false },
            disabled,
            face,
          ));
        }
        body.push(h('div', { className: 'dsh-ca-group', key: tier.id }, group));
      }

      // 动作条与官方一致：失败提示占满左侧，右对齐的「放弃修改」在前、「保存」在后。
      const footer = [];
      if (state.invalid === true) {
        footer.push(h('p', { className: 'dsh-ca-error', key: 'invalid', role: 'status' },
          '有字段的取值不在允许范围内，已阻止保存。'));
      } else if (state.failed === true) {
        footer.push(h('p', { className: 'dsh-ca-error', key: 'failed', role: 'status' },
          '保存未生效：宿主拒绝了这次写入，草稿已保留，请修正后重试。'));
      }
      footer.push(h('button', {
        className: 'dsh-ca-discard',
        type: 'button',
        key: 'discard',
        disabled: disabled || state.dirty !== true || state.saving === true,
        onClick: () => { face.discard(); },
      }, '放弃修改'));
      footer.push(h('button', {
        className: 'dsh-ca-save',
        type: 'button',
        key: 'save',
        disabled: disabled || state.dirty !== true || state.invalid === true || state.saving === true,
        onClick: () => { face.save(); },
      }, state.saving === true ? '保存中…' : '保存'));
      body.push(h('div', { className: 'dsh-ca-footer', key: 'footer' }, footer));

      return h('li', { className: open ? 'dsh-ca-card dsh-ca-card-open' : 'dsh-ca-card' }, [
        header,
        open ? h('div', { className: 'dsh-ca-body', key: 'body' }, body) : null,
      ]);
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
