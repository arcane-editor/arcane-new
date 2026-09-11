#if UNITYIDE_HAS_INPUT_SYSTEM
using System.Linq;
using NUnit.Framework;
using UnityEngine.InputSystem;
using UnityIDE.Bridge;

namespace UnityIDE.Tests
{
    public class InputDeliveryTests
    {
        [TestCase("keyboard", "space", "<Keyboard>/space")]
        [TestCase("mouse", "leftButton", "<Mouse>/leftButton")]
        [TestCase("gamepad", "buttonSouth", "<Gamepad>/buttonSouth")]
        public void SyntheticInputReachesActualActionBindingsAndCleanupRemovesDevices(string device, string control, string binding)
        {
            Assert.IsNotNull(AutomationInput.Create, "Optional Input System adapter was not registered.");
            var existing = InputSystem.devices.ToArray();
            using (var input = AutomationInput.Create())
            using (var action = new InputAction("Test", InputActionType.Button, binding)) {
                action.Enable(); input.Send(device, control, new[] { 1f }); InputSystem.Update();
                Assert.Greater(action.ReadValue<float>(), .5f);
                input.Send(device, control, new[] { 0f }); InputSystem.Update(); Assert.AreEqual(0f, action.ReadValue<float>());
            }
            CollectionAssert.AreEquivalent(existing, InputSystem.devices.ToArray());
        }
        [Test]
        public void BrokenBindingDoesNotReceiveUnrelatedInput()
        {
            using (var input = AutomationInput.Create())
            using (var action = new InputAction("Broken", InputActionType.Button, "<Keyboard>/enter")) {
                action.Enable(); input.Send("keyboard", "space", new[] { 1f }); InputSystem.Update();
                Assert.AreEqual(0f, action.ReadValue<float>(), "The harness must not invoke gameplay directly to mask broken bindings.");
            }
        }
        [Test]
        public void TouchEventsUseARealTouchscreenAndAreReleased()
        {
            var existing = InputSystem.devices.ToArray();
            using (var input = AutomationInput.Create()) {
                input.Send("touch", "position", new[] { 100f, 80f, 1f }); InputSystem.Update();
                var touch = InputSystem.devices.OfType<Touchscreen>().Single(d => !existing.Contains(d));
                Assert.IsTrue(touch.primaryTouch.press.isPressed);
                input.Send("touch", "position", new[] { 100f, 80f, 0f }); InputSystem.Update();
                Assert.IsFalse(touch.primaryTouch.press.isPressed);
            }
            CollectionAssert.AreEquivalent(existing, InputSystem.devices.ToArray());
        }
    }
}
#endif
