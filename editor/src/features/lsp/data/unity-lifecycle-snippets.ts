export interface UnityLifecycleMethod {
  name: string;
  signature: string;
  detail: string;
  /** The snippet body with parameters as placeholders */
  snippetBody: string;
}

export const UNITY_LIFECYCLE_METHODS: UnityLifecycleMethod[] = [
  {
    name: 'Awake',
    signature: 'void Awake()',
    detail: 'Called when the script instance is being loaded',
    snippetBody: 'private void Awake()\n{\n    $0\n}',
  },
  {
    name: 'Start',
    signature: 'void Start()',
    detail: 'Called before the first frame update',
    snippetBody: 'private void Start()\n{\n    $0\n}',
  },
  {
    name: 'Update',
    signature: 'void Update()',
    detail: 'Called once per frame',
    snippetBody: 'private void Update()\n{\n    $0\n}',
  },
  {
    name: 'FixedUpdate',
    signature: 'void FixedUpdate()',
    detail: 'Called every fixed framerate frame',
    snippetBody: 'private void FixedUpdate()\n{\n    $0\n}',
  },
  {
    name: 'LateUpdate',
    signature: 'void LateUpdate()',
    detail: 'Called after all Update functions',
    snippetBody: 'private void LateUpdate()\n{\n    $0\n}',
  },
  {
    name: 'OnEnable',
    signature: 'void OnEnable()',
    detail: 'Called when the object becomes enabled',
    snippetBody: 'private void OnEnable()\n{\n    $0\n}',
  },
  {
    name: 'OnDisable',
    signature: 'void OnDisable()',
    detail: 'Called when the object becomes disabled',
    snippetBody: 'private void OnDisable()\n{\n    $0\n}',
  },
  {
    name: 'OnDestroy',
    signature: 'void OnDestroy()',
    detail: 'Called when the MonoBehaviour is destroyed',
    snippetBody: 'private void OnDestroy()\n{\n    $0\n}',
  },
  {
    name: 'OnGUI',
    signature: 'void OnGUI()',
    detail: 'Called for rendering and handling GUI events',
    snippetBody: 'private void OnGUI()\n{\n    $0\n}',
  },
  {
    name: 'OnValidate',
    signature: 'void OnValidate()',
    detail: 'Called when the script is loaded or a value changes in the Inspector',
    snippetBody: 'private void OnValidate()\n{\n    $0\n}',
  },
  {
    name: 'OnApplicationQuit',
    signature: 'void OnApplicationQuit()',
    detail: 'Called before the application quits',
    snippetBody: 'private void OnApplicationQuit()\n{\n    $0\n}',
  },
  {
    name: 'OnApplicationPause',
    signature: 'void OnApplicationPause(bool pauseStatus)',
    detail: 'Called when the application pauses',
    snippetBody: 'private void OnApplicationPause(bool ${1:pauseStatus})\n{\n    $0\n}',
  },
  {
    name: 'OnCollisionEnter',
    signature: 'void OnCollisionEnter(Collision collision)',
    detail: 'Called when a collision starts',
    snippetBody: 'private void OnCollisionEnter(Collision ${1:collision})\n{\n    $0\n}',
  },
  {
    name: 'OnCollisionExit',
    signature: 'void OnCollisionExit(Collision collision)',
    detail: 'Called when a collision ends',
    snippetBody: 'private void OnCollisionExit(Collision ${1:collision})\n{\n    $0\n}',
  },
  {
    name: 'OnCollisionStay',
    signature: 'void OnCollisionStay(Collision collision)',
    detail: 'Called every frame during a collision',
    snippetBody: 'private void OnCollisionStay(Collision ${1:collision})\n{\n    $0\n}',
  },
  {
    name: 'OnCollisionEnter2D',
    signature: 'void OnCollisionEnter2D(Collision2D collision)',
    detail: 'Called when a 2D collision starts',
    snippetBody: 'private void OnCollisionEnter2D(Collision2D ${1:collision})\n{\n    $0\n}',
  },
  {
    name: 'OnCollisionExit2D',
    signature: 'void OnCollisionExit2D(Collision2D collision)',
    detail: 'Called when a 2D collision ends',
    snippetBody: 'private void OnCollisionExit2D(Collision2D ${1:collision})\n{\n    $0\n}',
  },
  {
    name: 'OnTriggerEnter',
    signature: 'void OnTriggerEnter(Collider other)',
    detail: 'Called when a trigger collider is entered',
    snippetBody: 'private void OnTriggerEnter(Collider ${1:other})\n{\n    $0\n}',
  },
  {
    name: 'OnTriggerExit',
    signature: 'void OnTriggerExit(Collider other)',
    detail: 'Called when a trigger collider is exited',
    snippetBody: 'private void OnTriggerExit(Collider ${1:other})\n{\n    $0\n}',
  },
  {
    name: 'OnTriggerStay',
    signature: 'void OnTriggerStay(Collider other)',
    detail: 'Called every frame while inside a trigger',
    snippetBody: 'private void OnTriggerStay(Collider ${1:other})\n{\n    $0\n}',
  },
  {
    name: 'OnTriggerEnter2D',
    signature: 'void OnTriggerEnter2D(Collider2D other)',
    detail: 'Called when a 2D trigger is entered',
    snippetBody: 'private void OnTriggerEnter2D(Collider2D ${1:other})\n{\n    $0\n}',
  },
  {
    name: 'OnTriggerExit2D',
    signature: 'void OnTriggerExit2D(Collider2D other)',
    detail: 'Called when a 2D trigger is exited',
    snippetBody: 'private void OnTriggerExit2D(Collider2D ${1:other})\n{\n    $0\n}',
  },
  {
    name: 'OnMouseDown',
    signature: 'void OnMouseDown()',
    detail: 'Called when the mouse button is pressed over the collider',
    snippetBody: 'private void OnMouseDown()\n{\n    $0\n}',
  },
  {
    name: 'OnMouseUp',
    signature: 'void OnMouseUp()',
    detail: 'Called when the mouse button is released',
    snippetBody: 'private void OnMouseUp()\n{\n    $0\n}',
  },
  {
    name: 'OnMouseEnter',
    signature: 'void OnMouseEnter()',
    detail: 'Called when the mouse enters the collider',
    snippetBody: 'private void OnMouseEnter()\n{\n    $0\n}',
  },
  {
    name: 'OnMouseExit',
    signature: 'void OnMouseExit()',
    detail: 'Called when the mouse exits the collider',
    snippetBody: 'private void OnMouseExit()\n{\n    $0\n}',
  },
  {
    name: 'OnBecameVisible',
    signature: 'void OnBecameVisible()',
    detail: 'Called when the renderer became visible',
    snippetBody: 'private void OnBecameVisible()\n{\n    $0\n}',
  },
  {
    name: 'OnBecameInvisible',
    signature: 'void OnBecameInvisible()',
    detail: 'Called when the renderer is no longer visible',
    snippetBody: 'private void OnBecameInvisible()\n{\n    $0\n}',
  },
  {
    name: 'OnDrawGizmos',
    signature: 'void OnDrawGizmos()',
    detail: 'Called for drawing gizmos in the Scene view',
    snippetBody: 'private void OnDrawGizmos()\n{\n    $0\n}',
  },
  {
    name: 'OnDrawGizmosSelected',
    signature: 'void OnDrawGizmosSelected()',
    detail: 'Called for drawing gizmos when selected',
    snippetBody: 'private void OnDrawGizmosSelected()\n{\n    $0\n}',
  },
  {
    name: 'OnAnimatorMove',
    signature: 'void OnAnimatorMove()',
    detail: 'Called for processing root motion',
    snippetBody: 'private void OnAnimatorMove()\n{\n    $0\n}',
  },
];
