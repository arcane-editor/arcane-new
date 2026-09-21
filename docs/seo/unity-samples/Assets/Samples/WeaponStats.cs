using UnityEngine;
using UnityEngine.Serialization;

namespace UnityIdeSeoSamples
{
    [CreateAssetMenu(menuName = "SEO samples/Weapon stats")]
    public class WeaponStats : ScriptableObject
    {
        [FormerlySerializedAs("oldDamage")]
        public int damage;
    }
}
