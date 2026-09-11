using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.InputSystem.Users;
using UnityIDE.Bridge;

namespace UnityIDE.Automation
{
    [InitializeOnLoad]
    internal static class PlaytestInputRegistration
    {
        static PlaytestInputRegistration() { AutomationInput.Create = () => new PlaytestInputAdapter(); }
    }

    internal sealed class PlaytestInputAdapter : IAutomationInput
    {
        private readonly Dictionary<string, InputDevice> _devices = new Dictionary<string, InputDevice>();
        private readonly HashSet<Key> _keys = new HashSet<Key>();
        private MouseState _mouse;
        private GamepadState _gamepad;
        private int _touchId = 1;
        private bool _touchActive;

        public void Send(string device, string control, float[] value)
        {
            if (value == null || value.Length == 0) throw new ArgumentException("An input value is required.");
            InputDevice target = Device(device);
            // Pair the synthetic device with real PlayerInput users. Removing it
            // in Dispose restores their original pairing; no game method is invoked.
            foreach (var player in PlayerInput.all)
                if (player.user.valid) InputUser.PerformPairingWithDevice(target, player.user);
            control = (control ?? "").TrimStart('/');
            if (control.Contains("/")) control = control.Substring(control.LastIndexOf('/') + 1);
            switch (device)
            {
                case "keyboard":
                    var key = target.TryGetChildControl<KeyControl>(control);
                    if (key == null) throw new ArgumentException("Keyboard control not found: " + control);
                    if (value[0] > 0) _keys.Add(key.keyCode); else _keys.Remove(key.keyCode);
                    var keys = new Key[_keys.Count]; _keys.CopyTo(keys);
                    InputSystem.QueueStateEvent(target, new KeyboardState(keys)); break;
                case "mouse":
                    if (control == "position") _mouse.position = Vector(value);
                    else if (control == "delta") _mouse.delta = Vector(value);
                    else if (control == "scroll") _mouse.scroll = Vector(value);
                    else {
                        MouseButton button = control == "leftButton" ? MouseButton.Left : control == "rightButton" ? MouseButton.Right : control == "middleButton" ? MouseButton.Middle : throw new ArgumentException("Unknown mouse control.");
                        _mouse = _mouse.WithButton(button, value[0] > 0);
                    }
                    InputSystem.QueueStateEvent(target, _mouse); _mouse.delta = Vector2.zero; _mouse.scroll = Vector2.zero; break;
                case "gamepad":
                    if (control == "leftStick") _gamepad.leftStick = Vector(value);
                    else if (control == "rightStick") _gamepad.rightStick = Vector(value);
                    else if (control == "leftTrigger") _gamepad.leftTrigger = value[0];
                    else if (control == "rightTrigger") _gamepad.rightTrigger = value[0];
                    else {
                        string button = control.StartsWith("button", StringComparison.Ordinal) ? control.Substring(6) : control;
                        if (!Enum.TryParse(button, true, out GamepadButton parsed)) throw new ArgumentException("Unknown gamepad button: " + control);
                        _gamepad = _gamepad.WithButton(parsed, value[0] > 0);
                    }
                    InputSystem.QueueStateEvent(target, _gamepad); break;
                case "touch":
                    if (value.Length < 3) throw new ArgumentException("Touch needs [x, y, pressed].");
                    bool pressed = value[2] > 0;
                    if (!_touchActive && !pressed) return;
                    var phase = pressed ? _touchActive ? UnityEngine.InputSystem.TouchPhase.Moved : UnityEngine.InputSystem.TouchPhase.Began : UnityEngine.InputSystem.TouchPhase.Ended;
                    InputSystem.QueueStateEvent(target, new TouchState { touchId = _touchId, phase = phase, position = new Vector2(value[0], value[1]) });
                    if (!pressed) _touchId++; _touchActive = pressed; break;
                default: throw new ArgumentException("Unsupported input device.");
            }
        }

        private InputDevice Device(string kind)
        {
            if (_devices.TryGetValue(kind, out var device)) return device;
            string layout = kind == "keyboard" ? "Keyboard" : kind == "mouse" ? "Mouse" : kind == "gamepad" ? "Gamepad" : kind == "touch" ? "Touchscreen" : throw new ArgumentException("Unsupported device.");
            device = InputSystem.AddDevice(layout, "UnityIDE_" + layout); _devices.Add(kind, device); return device;
        }
        private static Vector2 Vector(float[] values)
        {
            if (values.Length < 2) throw new ArgumentException("This control needs [x, y].");
            return new Vector2(values[0], values[1]);
        }
        public void Dispose()
        {
            foreach (var device in _devices.Values) {
                if (!device.added) continue;
                InputSystem.ResetDevice(device);
                InputSystem.RemoveDevice(device);
            }
            _devices.Clear(); _keys.Clear();
        }
    }
}
