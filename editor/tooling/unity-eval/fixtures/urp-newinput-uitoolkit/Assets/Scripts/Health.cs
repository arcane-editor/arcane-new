using UnityEngine;

public class Health : MonoBehaviour
{
    [SerializeField] private int maxHealth = 100;

    public int Current { get; private set; }

    void Awake()
    {
        Current = maxHealth;
    }
}
