// UI Toolkit's built-in control table: the C# inheritance chain and the USS
// classes each control generates for itself.
//
// **Why this is load-bearing rather than a nicety.** A USS type selector matches
// the C# inheritance chain, not the authored tag. `VisualElement { }` therefore
// matches *every* element in a document, and `.unity-button { }` matches a
// `<ui:Button>` that never spelled that class in UXML. In Unity's own
// stylesheets `.unity-base-field` appears 63 times and `#unity-checkmark` 27.
// Render a `<ui:Button>` as a bare div and none of those rules apply — the
// preview comes out unstyled and looks like the translator is broken when it is
// the type model that is missing.
//
// The renderer stamps `typeChain` onto each node as `u-t-*` classes, which is
// what `compileSelector`'s type-selector rewrite matches against. Data, not
// logic: adding a control is one row.
//
// A leaf module — no imports — so rules, renderer and Bun tests all load it.

export interface UxmlControl {
  /** The UXML tag, prefix stripped: `Button`. */
  typeName: string;
  /**
   * Most-derived first, `VisualElement` last. Every entry becomes a `u-t-*`
   * class on the rendered node.
   */
  typeChain: string[];
  /** USS classes Unity's own constructor adds. Authored UXML never lists these. */
  ussClasses: string[];
}

const VE = 'VisualElement';
const BINDABLE = ['BindableElement', VE];
const TEXT = ['TextElement', ...BINDABLE];
const FIELD = ['BaseField', ...BINDABLE];

/** `-1` on purpose: these are the roots every other chain ends with. */
const CONTROLS: readonly UxmlControl[] = [
  { typeName: VE, typeChain: [VE], ussClasses: [] },
  { typeName: 'BindableElement', typeChain: BINDABLE, ussClasses: [] },
  { typeName: 'TextElement', typeChain: TEXT, ussClasses: ['unity-text-element'] },

  { typeName: 'Label', typeChain: ['Label', ...TEXT], ussClasses: ['unity-label', 'unity-text-element'] },
  { typeName: 'Button', typeChain: ['Button', ...TEXT], ussClasses: ['unity-button', 'unity-text-element'] },
  { typeName: 'Box', typeChain: ['Box', VE], ussClasses: ['unity-box'] },
  { typeName: 'Image', typeChain: ['Image', VE], ussClasses: ['unity-image'] },
  { typeName: 'HelpBox', typeChain: ['HelpBox', VE], ussClasses: ['unity-help-box'] },
  { typeName: 'Scroller', typeChain: ['Scroller', VE], ussClasses: ['unity-scroller'] },
  { typeName: 'ScrollView', typeChain: ['ScrollView', VE], ussClasses: ['unity-scroll-view'] },
  { typeName: 'ListView', typeChain: ['ListView', 'BaseVerticalCollectionView', ...BINDABLE], ussClasses: ['unity-list-view', 'unity-collection-view'] },
  { typeName: 'TreeView', typeChain: ['TreeView', 'BaseVerticalCollectionView', ...BINDABLE], ussClasses: ['unity-tree-view', 'unity-collection-view'] },
  { typeName: 'MultiColumnListView', typeChain: ['MultiColumnListView', 'BaseVerticalCollectionView', ...BINDABLE], ussClasses: ['unity-multi-column-list-view', 'unity-collection-view'] },
  { typeName: 'MultiColumnTreeView', typeChain: ['MultiColumnTreeView', 'BaseVerticalCollectionView', ...BINDABLE], ussClasses: ['unity-multi-column-tree-view', 'unity-collection-view'] },
  { typeName: 'TwoPaneSplitView', typeChain: ['TwoPaneSplitView', VE], ussClasses: ['unity-two-pane-split-view'] },
  { typeName: 'GroupBox', typeChain: ['GroupBox', ...BINDABLE], ussClasses: ['unity-group-box'] },
  { typeName: 'Foldout', typeChain: ['Foldout', ...BINDABLE], ussClasses: ['unity-foldout'] },
  { typeName: 'TabView', typeChain: ['TabView', ...BINDABLE], ussClasses: ['unity-tab-view'] },
  { typeName: 'Tab', typeChain: ['Tab', ...BINDABLE], ussClasses: ['unity-tab'] },
  { typeName: 'ProgressBar', typeChain: ['ProgressBar', 'AbstractProgressBar', ...BINDABLE], ussClasses: ['unity-progress-bar'] },

  { typeName: 'Toggle', typeChain: ['Toggle', 'BaseBoolField', ...FIELD], ussClasses: ['unity-toggle', 'unity-base-field'] },
  { typeName: 'RadioButton', typeChain: ['RadioButton', 'BaseBoolField', ...FIELD], ussClasses: ['unity-radio-button', 'unity-base-field'] },
  { typeName: 'RadioButtonGroup', typeChain: ['RadioButtonGroup', 'BaseField', ...BINDABLE], ussClasses: ['unity-radio-button-group', 'unity-base-field'] },

  { typeName: 'TextField', typeChain: ['TextField', 'TextInputBaseField', ...FIELD], ussClasses: ['unity-text-field', 'unity-base-text-field', 'unity-base-field'] },
  { typeName: 'IntegerField', typeChain: ['IntegerField', 'TextValueField', 'TextInputBaseField', ...FIELD], ussClasses: ['unity-integer-field', 'unity-base-text-field', 'unity-base-field'] },
  { typeName: 'FloatField', typeChain: ['FloatField', 'TextValueField', 'TextInputBaseField', ...FIELD], ussClasses: ['unity-float-field', 'unity-base-text-field', 'unity-base-field'] },
  { typeName: 'DoubleField', typeChain: ['DoubleField', 'TextValueField', 'TextInputBaseField', ...FIELD], ussClasses: ['unity-double-field', 'unity-base-text-field', 'unity-base-field'] },
  { typeName: 'LongField', typeChain: ['LongField', 'TextValueField', 'TextInputBaseField', ...FIELD], ussClasses: ['unity-long-field', 'unity-base-text-field', 'unity-base-field'] },
  { typeName: 'UnsignedIntegerField', typeChain: ['UnsignedIntegerField', 'TextValueField', 'TextInputBaseField', ...FIELD], ussClasses: ['unity-unsigned-integer-field', 'unity-base-text-field', 'unity-base-field'] },
  { typeName: 'UnsignedLongField', typeChain: ['UnsignedLongField', 'TextValueField', 'TextInputBaseField', ...FIELD], ussClasses: ['unity-unsigned-long-field', 'unity-base-text-field', 'unity-base-field'] },
  { typeName: 'Hash128Field', typeChain: ['Hash128Field', 'TextValueField', 'TextInputBaseField', ...FIELD], ussClasses: ['unity-hash128-field', 'unity-base-text-field', 'unity-base-field'] },

  { typeName: 'Vector2Field', typeChain: ['Vector2Field', 'BaseCompositeField', ...FIELD], ussClasses: ['unity-vector2-field', 'unity-composite-field', 'unity-base-field'] },
  { typeName: 'Vector3Field', typeChain: ['Vector3Field', 'BaseCompositeField', ...FIELD], ussClasses: ['unity-vector3-field', 'unity-composite-field', 'unity-base-field'] },
  { typeName: 'Vector4Field', typeChain: ['Vector4Field', 'BaseCompositeField', ...FIELD], ussClasses: ['unity-vector4-field', 'unity-composite-field', 'unity-base-field'] },
  { typeName: 'Vector2IntField', typeChain: ['Vector2IntField', 'BaseCompositeField', ...FIELD], ussClasses: ['unity-vector2-int-field', 'unity-composite-field', 'unity-base-field'] },
  { typeName: 'Vector3IntField', typeChain: ['Vector3IntField', 'BaseCompositeField', ...FIELD], ussClasses: ['unity-vector3-int-field', 'unity-composite-field', 'unity-base-field'] },
  { typeName: 'RectField', typeChain: ['RectField', 'BaseCompositeField', ...FIELD], ussClasses: ['unity-rect-field', 'unity-composite-field', 'unity-base-field'] },
  { typeName: 'RectIntField', typeChain: ['RectIntField', 'BaseCompositeField', ...FIELD], ussClasses: ['unity-rect-int-field', 'unity-composite-field', 'unity-base-field'] },
  { typeName: 'BoundsField', typeChain: ['BoundsField', 'BaseCompositeField', ...FIELD], ussClasses: ['unity-bounds-field', 'unity-composite-field', 'unity-base-field'] },
  { typeName: 'BoundsIntField', typeChain: ['BoundsIntField', 'BaseCompositeField', ...FIELD], ussClasses: ['unity-bounds-int-field', 'unity-composite-field', 'unity-base-field'] },

  { typeName: 'Slider', typeChain: ['Slider', 'BaseSlider', ...FIELD], ussClasses: ['unity-slider', 'unity-base-slider', 'unity-base-field'] },
  { typeName: 'SliderInt', typeChain: ['SliderInt', 'BaseSlider', ...FIELD], ussClasses: ['unity-slider-int', 'unity-base-slider', 'unity-base-field'] },
  { typeName: 'MinMaxSlider', typeChain: ['MinMaxSlider', ...FIELD], ussClasses: ['unity-min-max-slider', 'unity-base-field'] },

  { typeName: 'DropdownField', typeChain: ['DropdownField', 'PopupField', 'BasePopupField', ...FIELD], ussClasses: ['unity-dropdown-field', 'unity-base-popup-field', 'unity-base-field'] },
  { typeName: 'PopupField', typeChain: ['PopupField', 'BasePopupField', ...FIELD], ussClasses: ['unity-popup-field', 'unity-base-popup-field', 'unity-base-field'] },
  { typeName: 'EnumField', typeChain: ['EnumField', 'BasePopupField', ...FIELD], ussClasses: ['unity-enum-field', 'unity-base-popup-field', 'unity-base-field'] },
  { typeName: 'EnumFlagsField', typeChain: ['EnumFlagsField', 'BaseMaskField', 'BasePopupField', ...FIELD], ussClasses: ['unity-enum-flags-field', 'unity-base-popup-field', 'unity-base-field'] },

  // Document-level elements. `UXML` is the file root and is not a real
  // VisualElement, but treating it as one keeps the tree uniform.
  { typeName: 'UXML', typeChain: [VE], ussClasses: [] },
  { typeName: 'Instance', typeChain: ['TemplateContainer', VE], ussClasses: [] },
];

const BY_NAME: ReadonlyMap<string, UxmlControl> = new Map(
  CONTROLS.map((c) => [c.typeName, c]),
);

/** Every built-in control, for tests and completion data. */
export const UXML_CONTROLS = CONTROLS;

/** True when `typeName` is a UI Toolkit built-in rather than a custom C# control. */
export function isBuiltinControl(typeName: string): boolean {
  return BY_NAME.has(typeName);
}

/**
 * The inheritance chain for a UXML tag, most-derived first.
 *
 * A custom control (`sg:ResizableElement`, `MyNs.Thing`) is unknown to us — we
 * cannot see its C# — so it gets `[typeName, 'VisualElement']`. That is the
 * honest floor: every VisualElement subclass really does derive from
 * VisualElement, so `VisualElement { }` still matches it, and we simply do not
 * know about any intermediate bases.
 */
export function typeChainFor(typeName: string): string[] {
  const known = BY_NAME.get(typeName);
  if (known) return known.typeChain;
  return typeName === VE ? [VE] : [typeName, VE];
}

/** The USS classes Unity's own constructor adds for this control. */
export function generatedUssClasses(typeName: string): string[] {
  return BY_NAME.get(typeName)?.ussClasses ?? [];
}

/**
 * Element names Unity's built-in controls create in C#, which therefore appear
 * in no UXML file anywhere.
 *
 * This is the false-positive floor for the query check. Measured against 12,898
 * real C# files: 208 distinct literal names are queried, 21 exist in no `.uxml`,
 * and all 21 are of this kind. A checker without this list flags valid code
 * about 10% of the time — which, for a feature whose entire pitch is trust,
 * is disqualifying.
 */
export const BUILTIN_PART_NAMES: ReadonlySet<string> = new Set([
  'unity-content-container',
  'unity-content-viewport',
  'unity-content-and-vertical-scroll-container',
  'unity-checkmark',
  'unity-checkmark-container',
  'unity-drag-container',
  'unity-dragger',
  'unity-dragger-border',
  'unity-tracker',
  'unity-slider',
  'unity-low-button',
  'unity-high-button',
  'unity-slider-horizontal',
  'unity-slider-vertical',
  'unity-horizontal-scroller',
  'unity-vertical-scroller',
  'unity-text-input',
  'unity-text-element',
  'unity-multiline-container',
  'unity-progress-bar',
  'unity-progress-bar__background',
  'unity-progress-bar__progress',
  'unity-progress-bar__title',
  'unity-tab-view__header-container',
  'unity-tab__header',
  'unity-list-view__empty-label',
  'unity-collection-view__item',
  'unity-foldout__input',
  'unity-foldout__checkmark',
  'unity-foldout__text',
  'unity-foldout__toggle',
  'unity-foldout__content',
  'unity-base-field__label',
  'unity-base-field__input',
  'unity-help-box__label',
  'unity-repeat-button',
]);

/**
 * True when `name` can only have come from a built-in control's constructor.
 *
 * The `unity-` prefix carries the check on its own: Unity reserves it for
 * generated parts, and no authored UXML in the measured corpus uses it. The
 * explicit set above is kept anyway so the intent is greppable and so a future
 * non-prefixed part can be added without weakening the rule to a prefix test.
 */
export function isBuiltinPartName(name: string): boolean {
  return name.startsWith('unity-') || BUILTIN_PART_NAMES.has(name);
}

// ── Attributes ───────────────────────────────────────────────────────────────

/**
 * Attributes every VisualElement accepts, so no control has to restate them.
 *
 * `binding-path` and the `data-source*` trio are inherited too: runtime binding
 * is declared on `BindableElement`, and authored UXML puts it on anything.
 */
export const COMMON_ATTRIBUTES: ReadonlySet<string> = new Set([
  'name',
  'class',
  'style',
  'tooltip',
  'picking-mode',
  'focusable',
  'enabled',
  'tabindex',
  'view-data-key',
  'usage-hints',
  'language-direction',
  'binding-path',
  'data-source',
  'data-source-path',
  'data-source-type',
]);

/**
 * Attributes a control adds on top of `COMMON_ATTRIBUTES`, keyed by type name.
 *
 * **This table is deliberately allowed to be incomplete**, which is why the
 * check that reads it is a WARNING and never blocks a write: UI Toolkit adds
 * attributes across Unity versions, and a control absent from this map is
 * skipped entirely rather than reported. Getting that backwards — refusing a
 * write over an attribute this file has not heard of yet — is precisely the
 * false positive `asset-checks.ts` warns teaches the agent to ignore the gate.
 *
 * Entries are the authored kebab-case names, not the C# property names.
 */
const EXTRA_ATTRIBUTES: Record<string, readonly string[]> = {
  // The bases add nothing of their own, but they need an entry: without one
  // `attributesFor` reports "no data" and the commonest element in every
  // document goes unchecked.
  VisualElement: [],
  BindableElement: [],

  // Text
  TextElement: ['text', 'enable-rich-text', 'display-tooltip-when-elided', 'parse-escape-sequences', 'emoji-fallback-support', 'selectable'],
  Label: ['text', 'enable-rich-text', 'display-tooltip-when-elided', 'parse-escape-sequences', 'emoji-fallback-support', 'selectable'],
  Button: ['text', 'enable-rich-text', 'display-tooltip-when-elided', 'parse-escape-sequences', 'emoji-fallback-support', 'icon-image'],

  // Containers
  Box: [],
  GroupBox: ['text'],
  HelpBox: ['text', 'message-type'],
  Foldout: ['text', 'value', 'toggle-on-label-click'],
  TabView: ['reorderable'],
  Tab: ['label', 'icon-image', 'closeable'],
  TwoPaneSplitView: ['fixed-pane-index', 'fixed-pane-initial-dimension', 'orientation'],
  ScrollView: [
    'mode', 'horizontal-scroller-visibility', 'vertical-scroller-visibility',
    'nested-interaction-kind', 'scroll-deceleration-rate', 'elasticity',
    'touch-scroll-type', 'mouse-wheel-scroll-size', 'horizontal-page-size',
    'vertical-page-size', 'elastic-animation-interval-ms',
  ],

  // Graphics
  Image: ['image', 'sprite', 'vector-image', 'scale-mode', 'tint-color', 'source-rect', 'uv'],

  // Collections
  ListView: COLLECTION_ATTRIBUTES(),
  TreeView: [...COLLECTION_ATTRIBUTES(), 'auto-expand'],
  MultiColumnListView: [...COLLECTION_ATTRIBUTES(), 'sorting-mode'],
  MultiColumnTreeView: [...COLLECTION_ATTRIBUTES(), 'auto-expand', 'sorting-mode'],

  // Booleans
  Toggle: ['label', 'value', 'text', 'toggle-on-label-click'],
  RadioButton: ['label', 'value', 'text'],
  RadioButtonGroup: ['label', 'value', 'choices'],

  // Text-entry fields
  TextField: [
    'label', 'value', 'password', 'mask-char', 'readonly', 'is-delayed',
    'max-length', 'multiline', 'auto-correction', 'hide-mobile-input',
    'keyboard-type', 'select-all-on-mouse-up', 'select-all-on-focus',
    'vertical-scroller-visibility', 'select-word-by-double-click',
    'placeholder-text', 'hide-placeholder-on-focus',
  ],
  IntegerField: NUMERIC_FIELD_ATTRIBUTES(),
  FloatField: NUMERIC_FIELD_ATTRIBUTES(),
  DoubleField: NUMERIC_FIELD_ATTRIBUTES(),
  LongField: NUMERIC_FIELD_ATTRIBUTES(),
  UnsignedIntegerField: NUMERIC_FIELD_ATTRIBUTES(),
  UnsignedLongField: NUMERIC_FIELD_ATTRIBUTES(),
  Hash128Field: NUMERIC_FIELD_ATTRIBUTES(),

  // Composite fields carry one attribute per component, not a `value`.
  Vector2Field: ['label', 'x', 'y'],
  Vector2IntField: ['label', 'x', 'y'],
  Vector3Field: ['label', 'x', 'y', 'z'],
  Vector3IntField: ['label', 'x', 'y', 'z'],
  Vector4Field: ['label', 'x', 'y', 'z', 'w'],
  RectField: ['label', 'x', 'y', 'w', 'h'],
  RectIntField: ['label', 'x', 'y', 'w', 'h'],
  BoundsField: ['label', 'cx', 'cy', 'cz', 'ex', 'ey', 'ez'],
  BoundsIntField: ['label', 'px', 'py', 'pz', 'sx', 'sy', 'sz'],

  // Ranges
  Slider: ['label', 'value', 'low-value', 'high-value', 'direction', 'page-size', 'show-input-field', 'inverted', 'fill'],
  SliderInt: ['label', 'value', 'low-value', 'high-value', 'direction', 'page-size', 'show-input-field', 'inverted', 'fill'],
  MinMaxSlider: ['label', 'min-value', 'max-value', 'low-limit', 'high-limit'],
  Scroller: ['value', 'low-value', 'high-value', 'direction'],
  ProgressBar: ['value', 'title', 'low-value', 'high-value'],

  // Choice fields
  DropdownField: ['label', 'index', 'choices', 'value'],
  PopupField: ['label', 'index', 'choices', 'value'],
  EnumField: ['label', 'type', 'value', 'include-obsolete-values'],
  EnumFlagsField: ['label', 'type', 'value', 'include-obsolete-values'],

  // Document-level
  UXML: ['editor-extension-mode', 'editor-uxml-path'],
  Instance: ['template'],
};

/** Shared by every `BaseVerticalCollectionView`. Written as a function so the map above stays flat. */
function COLLECTION_ATTRIBUTES(): string[] {
  return [
    'virtualization-method', 'fixed-item-height', 'show-border', 'selection-type',
    'show-alternating-row-backgrounds', 'reorderable', 'horizontal-scrolling',
    'show-foldout-header', 'header-title', 'show-add-remove-footer', 'reorder-mode',
    'show-bound-collection-size', 'binding-source-selection-mode', 'allow-add', 'allow-remove',
  ];
}

/** Shared by every `TextValueField`. */
function NUMERIC_FIELD_ATTRIBUTES(): string[] {
  return ['label', 'value', 'is-delayed', 'readonly', 'max-length'];
}

/**
 * The metadata tags' attributes, stated exactly rather than on top of
 * `COMMON_ATTRIBUTES`: `<Style>` and `<Template>` are not VisualElements, so
 * they take none of the element attributes.
 */
const METADATA_ATTRIBUTES: Record<string, readonly string[]> = {
  Style: ['src', 'path'],
  Template: ['name', 'src', 'path'],
};

/**
 * The attributes this element accepts, or `null` when the table has no entry
 * for it — which a caller must treat as "do not check", never as "none".
 */
export function attributesFor(typeName: string): ReadonlySet<string> | null {
  const metadata = METADATA_ATTRIBUTES[typeName];
  if (metadata) return new Set(metadata);
  const extra = EXTRA_ATTRIBUTES[typeName];
  if (!extra) return null;
  return new Set([...COMMON_ATTRIBUTES, ...extra]);
}

/**
 * Document-level tags that are not VisualElements at all.
 *
 * `<Style>` and `<Template>` carry stylesheet and template references and are
 * stripped by the parser (`uxml-model.ts`'s `isMetadataElement`); they are still
 * legal tags, so an element check has to know them or it reports every document
 * that uses a stylesheet.
 */
export const UXML_METADATA_ELEMENTS: ReadonlySet<string> = new Set(['Style', 'Template']);

/** True when `localName` is a tag UI Toolkit itself defines — control or metadata. */
export function isKnownUxmlElement(localName: string): boolean {
  return isBuiltinControl(localName) || UXML_METADATA_ELEMENTS.has(localName);
}

/** Every tag name a `ui:`-namespaced document may legally use, sorted. */
export function knownUxmlElementNames(): string[] {
  return [...CONTROLS.map((c) => c.typeName), ...UXML_METADATA_ELEMENTS].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * Every attribute name any known control accepts, deduped and sorted.
 *
 * Completion data only. A per-element subset is what `attributesFor` is for —
 * offering the union everywhere is right for a completion list and would be
 * wrong for a check.
 */
export function allKnownAttributeNames(): string[] {
  const out = new Set<string>(COMMON_ATTRIBUTES);
  for (const table of [EXTRA_ATTRIBUTES, METADATA_ATTRIBUTES]) {
    for (const names of Object.values(table)) {
      for (const name of names) out.add(name);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}
