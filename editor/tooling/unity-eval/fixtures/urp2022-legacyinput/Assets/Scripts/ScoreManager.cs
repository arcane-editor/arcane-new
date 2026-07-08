using UnityEngine;

public class ScoreManager : MonoBehaviour
{
    [SerializeField] private int score;

    public void AddPoints(int amount)
    {
        score += amount;
    }
}
