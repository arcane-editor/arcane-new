using UnityEngine;

public class PlayerMover : MonoBehaviour
{
    [SerializeField] private float speed = 4f;

    void Update()
    {
        float h = Input.GetAxis("Horizontal");
        float v = Input.GetAxis("Vertical");
        transform.Translate(new Vector3(h, 0f, v) * speed * Time.deltaTime);
    }
}
