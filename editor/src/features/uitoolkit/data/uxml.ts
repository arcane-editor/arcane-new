// UXML (UI Toolkit markup) reuses Monaco's `xml` language for highlighting; we
// contribute UI Toolkit element + attribute completions scoped to `.uxml` files.
// Element names use the conventional `ui:` namespace prefix used in authored UXML.

export const UXML_ELEMENTS: string[] = [
  'ui:UXML', 'ui:VisualElement', 'ui:Box', 'ui:Button', 'ui:Label', 'ui:Image',
  'ui:ScrollView', 'ui:ListView', 'ui:TreeView', 'ui:Toggle',
  'ui:Slider', 'ui:SliderInt', 'ui:MinMaxSlider', 'ui:Scroller',
  'ui:TextField', 'ui:IntegerField', 'ui:FloatField', 'ui:DoubleField', 'ui:LongField',
  'ui:Vector2Field', 'ui:Vector3Field', 'ui:Vector4Field', 'ui:RectField', 'ui:BoundsField',
  'ui:Foldout', 'ui:PopupField', 'ui:DropdownField', 'ui:EnumField',
  'ui:ProgressBar', 'ui:RadioButton', 'ui:RadioButtonGroup', 'ui:GroupBox',
  'ui:Tab', 'ui:TabView', 'ui:HelpBox', 'ui:Template', 'ui:Instance', 'ui:Style',
  'ui:VisualTreeAsset', 'ui:BindableElement',
];

/** Common UXML attributes (per-element subsets exist, but these are broadly valid). */
export const UXML_ATTRIBUTES: string[] = [
  'name', 'class', 'style', 'text', 'value', 'label', 'tooltip',
  'binding-path', 'view-data-key', 'picking-mode', 'focusable', 'enabled',
  'tabindex', 'src', 'template', 'high-value', 'low-value', 'low-limit', 'high-limit',
];
