param(
    [Parameter(Mandatory=$true)]
    [string]$Action,
    [float]$Value = 0
)

$code = @"
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
    int k();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, System.Guid pguidEventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int f();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

public class AudioMaster {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    static IAudioEndpointVolume Vol() {
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        var IID_IAudioEndpointVolume = typeof(IAudioEndpointVolume).GUID;
        IAudioEndpointVolume aev = null;
        dev.Activate(ref IID_IAudioEndpointVolume, 23, 0, out aev);
        return aev;
    }
    public static float Get() {
        float v = 0;
        Vol().GetMasterVolumeLevelScalar(out v);
        return (float)Math.Round(v * 100);
    }
    public static void Set(float v) {
        float clamped = Math.Max(0.0f, Math.Min(100.0f, v));
        Vol().SetMasterVolumeLevelScalar(clamped / 100.0f, System.Guid.Empty);
    }
    public static void Mute(bool m) {
        Vol().SetMute(m, System.Guid.Empty);
    }
    public static void SendKey(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, 2, UIntPtr.Zero);
    }
    public static void ShowDesktop() {
        keybd_event(0x5B, 0, 0, UIntPtr.Zero); // LWin down
        keybd_event(0x44, 0, 0, UIntPtr.Zero); // D down
        keybd_event(0x44, 0, 2, UIntPtr.Zero); // D up
        keybd_event(0x5B, 0, 2, UIntPtr.Zero); // LWin up
    }
}
"@

Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue

switch ($Action.ToLower()) {
    "get" {
        [AudioMaster]::Get()
    }
    "set" {
        [AudioMaster]::Set($Value)
        [AudioMaster]::Get()
    }
    "mute" {
        [AudioMaster]::Mute($true)
        "muted"
    }
    "unmute" {
        [AudioMaster]::Mute($false)
        "unmuted"
    }
    "playpause" {
        [AudioMaster]::SendKey(0xB3)
        "ok"
    }
    "next" {
        [AudioMaster]::SendKey(0xB0)
        "ok"
    }
    "prev" {
        [AudioMaster]::SendKey(0xB1)
        "ok"
    }
    "stop" {
        [AudioMaster]::SendKey(0xB2)
        "ok"
    }
    "minimize_all" {
        [AudioMaster]::ShowDesktop()
        "ok"
    }
    "desktop" {
        [AudioMaster]::ShowDesktop()
        "ok"
    }
}
