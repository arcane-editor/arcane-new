using UnityEngine;

public class Mover : MonoBehaviour
{
    void update()
    {
        var rb = GetComponent<Rigidbody>();
        rb.AddForce(Vector3.forward);
    }
}
