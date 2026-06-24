// USS (Unity Style Sheets) is a CSS subset/superset. We reuse Monaco's `css`
// language for highlighting + IntelliSense and contribute these Unity-specific
// + common-layout property names as extra completions, scoped to `.uss` files.

export const USS_PROPERTIES: string[] = [
  // Layout (flexbox)
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'flex-wrap',
  'justify-content', 'align-items', 'align-self', 'align-content',
  'position', 'left', 'top', 'right', 'bottom', 'display', 'overflow', 'visibility',
  // Box
  'margin', 'margin-left', 'margin-top', 'margin-right', 'margin-bottom',
  'padding', 'padding-left', 'padding-top', 'padding-right', 'padding-bottom',
  'border-width', 'border-left-width', 'border-top-width', 'border-right-width', 'border-bottom-width',
  'border-color', 'border-left-color', 'border-top-color', 'border-right-color', 'border-bottom-color',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  // Visual
  'color', 'background-color', 'background-image', 'opacity', 'cursor',
  'font-size', 'white-space', 'text-overflow', 'letter-spacing', 'word-spacing',
  // Transform / transition
  'rotate', 'scale', 'translate', 'transform-origin',
  'transition', 'transition-property', 'transition-duration',
  'transition-timing-function', 'transition-delay',
  // Unity-specific
  '-unity-font', '-unity-font-definition', '-unity-font-style', '-unity-text-align',
  '-unity-background-scale-mode', '-unity-background-image-tint-color',
  '-unity-slice-left', '-unity-slice-top', '-unity-slice-right', '-unity-slice-bottom',
  '-unity-slice-scale', '-unity-text-outline-width', '-unity-text-outline-color',
  '-unity-overflow-clip-box', '-unity-paragraph-spacing',
];

/** Common USS pseudo-classes (state selectors). */
export const USS_PSEUDO: string[] = [
  ':hover', ':active', ':focus', ':selected', ':disabled', ':enabled',
  ':checked', ':root', ':inactive',
];
