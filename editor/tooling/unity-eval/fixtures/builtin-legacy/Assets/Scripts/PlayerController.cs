using UnityEngine;

public class PlayerController : MonoBehaviour
{
    [SerializeField] private float speed = 5f;

    private Rigidbody rb;

    void Start()
    {
        rb.linearVelocity = Vector3.zero;
    }

    void Update()
    {
        float h = Input.GetAxis("Horizontal");
        float v = Input.GetAxis("Vertical");
        transform.Translate(new Vector3(h, 0f, v) * speed * Time.deltaTime);
    }
}
