// Unity lifecycle methods database — ported from unity-lifecycle-db.ts

export interface LifecycleMethod {
  name: string;
  category: string;
  description: string;
}

export const UNITY_LIFECYCLE_METHODS: LifecycleMethod[] = [
  // Initialization
  { name: 'Awake', category: 'Initialization', description: 'Called when the script instance is being loaded' },
  { name: 'OnEnable', category: 'Initialization', description: 'Called when the object becomes enabled and active' },
  { name: 'Start', category: 'Initialization', description: 'Called before the first frame update' },
  { name: 'Reset', category: 'Initialization', description: 'Called when the user hits the Reset button in the Inspector' },

  // Update
  { name: 'Update', category: 'Update', description: 'Called once per frame' },
  { name: 'LateUpdate', category: 'Update', description: 'Called after all Update functions' },
  { name: 'FixedUpdate', category: 'Update', description: 'Called at fixed time intervals for physics' },

  // Physics
  { name: 'OnCollisionEnter', category: 'Physics', description: 'Called when collision starts' },
  { name: 'OnCollisionStay', category: 'Physics', description: 'Called while collision is ongoing' },
  { name: 'OnCollisionExit', category: 'Physics', description: 'Called when collision ends' },
  { name: 'OnCollisionEnter2D', category: 'Physics', description: '2D collision start' },
  { name: 'OnCollisionStay2D', category: 'Physics', description: '2D collision ongoing' },
  { name: 'OnCollisionExit2D', category: 'Physics', description: '2D collision end' },
  { name: 'OnTriggerEnter', category: 'Physics', description: 'Called when trigger collider is entered' },
  { name: 'OnTriggerStay', category: 'Physics', description: 'Called while inside a trigger' },
  { name: 'OnTriggerExit', category: 'Physics', description: 'Called when leaving a trigger' },
  { name: 'OnTriggerEnter2D', category: 'Physics', description: '2D trigger enter' },
  { name: 'OnTriggerStay2D', category: 'Physics', description: '2D trigger stay' },
  { name: 'OnTriggerExit2D', category: 'Physics', description: '2D trigger exit' },

  // Rendering
  { name: 'OnBecameVisible', category: 'Rendering', description: 'Called when the renderer became visible by a camera' },
  { name: 'OnBecameInvisible', category: 'Rendering', description: 'Called when the renderer is no longer visible' },
  { name: 'OnPreCull', category: 'Rendering', description: 'Called before a camera culls the scene' },
  { name: 'OnPreRender', category: 'Rendering', description: 'Called before a camera starts rendering' },
  { name: 'OnPostRender', category: 'Rendering', description: 'Called after a camera finishes rendering' },
  { name: 'OnRenderImage', category: 'Rendering', description: 'Called after scene rendering for post-processing' },
  { name: 'OnRenderObject', category: 'Rendering', description: 'Called after camera has rendered the scene' },
  { name: 'OnWillRenderObject', category: 'Rendering', description: 'Called for each camera if the object is visible' },
  { name: 'OnGUI', category: 'Rendering', description: 'Called for rendering and handling GUI events' },
  { name: 'OnDrawGizmos', category: 'Rendering', description: 'Called to draw gizmos in the Scene view' },
  { name: 'OnDrawGizmosSelected', category: 'Rendering', description: 'Called to draw gizmos when selected' },

  // Lifecycle
  { name: 'OnDisable', category: 'Lifecycle', description: 'Called when the object becomes disabled' },
  { name: 'OnDestroy', category: 'Lifecycle', description: 'Called when the MonoBehaviour will be destroyed' },
  { name: 'OnApplicationQuit', category: 'Lifecycle', description: 'Called before the application quits' },
  { name: 'OnApplicationPause', category: 'Lifecycle', description: 'Called when the application pauses' },
  { name: 'OnApplicationFocus', category: 'Lifecycle', description: 'Called when the application gains or loses focus' },

  // Animation
  { name: 'OnAnimatorMove', category: 'Animation', description: 'Called for processing animator movements' },
  { name: 'OnAnimatorIK', category: 'Animation', description: 'Called for setting up animation IK' },

  // Input
  { name: 'OnMouseDown', category: 'Input', description: 'Called when the mouse button is pressed over the collider' },
  { name: 'OnMouseUp', category: 'Input', description: 'Called when the mouse button is released' },
  { name: 'OnMouseDrag', category: 'Input', description: 'Called while the mouse is being dragged over the collider' },
  { name: 'OnMouseEnter', category: 'Input', description: 'Called when the mouse enters the collider' },
  { name: 'OnMouseExit', category: 'Input', description: 'Called when the mouse exits the collider' },
  { name: 'OnMouseOver', category: 'Input', description: 'Called every frame while the mouse is over the collider' },
  { name: 'OnMouseUpAsButton', category: 'Input', description: 'Called on mouse up if press was on the same collider' },

  // Network
  { name: 'OnPlayerConnected', category: 'Network', description: 'Called when a new player connects' },
  { name: 'OnPlayerDisconnected', category: 'Network', description: 'Called when a player disconnects' },
  { name: 'OnServerInitialized', category: 'Network', description: 'Called when the server has been initialized' },
  { name: 'OnConnectedToServer', category: 'Network', description: 'Called when connected to the server' },

  // Other
  { name: 'OnValidate', category: 'Editor', description: 'Called when script values are changed in the Inspector' },
  { name: 'OnParticleCollision', category: 'Physics', description: 'Called when a particle hits a collider' },
  { name: 'OnJointBreak', category: 'Physics', description: 'Called when a joint attached to the same game object breaks' },
  { name: 'OnControllerColliderHit', category: 'Physics', description: 'Called when the controller hits a collider' },
];

export const LIFECYCLE_METHOD_NAMES = new Set(UNITY_LIFECYCLE_METHODS.map((m) => m.name));
