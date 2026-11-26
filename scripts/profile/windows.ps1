param([int]$RootPid)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# Windows SDK: tlhelp32.h (process parent IDs) and winuser.h (display adapters).
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class BlazeProfileWindows {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Entry {
        public uint size, usage, pid;
        public UIntPtr heap;
        public uint module, threads, parent;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string name;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Adapter {
        public int size;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string device;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string name;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string key;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(IntPtr handle, ref Entry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(IntPtr handle, ref Entry entry);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplayDevices(string device, uint index, ref Adapter adapter, uint flags);

    public static Entry[] Processes() {
        const uint TH32CS_SNAPPROCESS = 2;
        const int ERROR_NO_MORE_FILES = 18;
        var handle = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (handle == new IntPtr(-1)) throw new Win32Exception();
        try {
            var entry = new Entry { size = (uint)Marshal.SizeOf(typeof(Entry)) };
            if (!Process32First(handle, ref entry)) throw new Win32Exception();
            var rows = new List<Entry>();
            do { rows.Add(entry); } while (Process32Next(handle, ref entry));
            if (Marshal.GetLastWin32Error() != ERROR_NO_MORE_FILES) throw new Win32Exception();
            return rows.ToArray();
        } finally {
            CloseHandle(handle);
        }
    }

    public static Adapter[] Adapters() {
        var adapter = new Adapter { size = Marshal.SizeOf(typeof(Adapter)) };
        var rows = new List<Adapter>();
        for (uint index = 0; EnumDisplayDevices(null, index, ref adapter, 0); index++) rows.Add(adapter);
        return rows.ToArray();
    }
}
'@

if ($RootPid) {
  $sampledAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $inventory = [BlazeProfileWindows]::Processes()
  $queue = [Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($RootPid)
  $tree = while ($queue.Count) {
    $parent = $queue.Dequeue()
    $inventory | Where-Object pid -eq $parent | ForEach-Object {
      $proc = Get-Process -Id $parent -ErrorAction SilentlyContinue
      [pscustomobject]@{
        pid = $_.pid
        parentPid = $_.parent
        name = $_.name
        workingSetBytes = $proc.WorkingSet64
        privateBytes = $proc.PrivateMemorySize64
      }
    }
    $inventory | Where-Object parent -eq $parent | ForEach-Object {
      $queue.Enqueue([int]$_.pid)
    }
  }
  @{ at = $sampledAt; processes = @($tree) } | ConvertTo-Json -Depth 4 -Compress
} else {
  Add-Type -AssemblyName System.Windows.Forms
  $screen = [Windows.Forms.Screen]::PrimaryScreen
  $power = [Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus
  $adapters = @([BlazeProfileWindows]::Adapters() | Select-Object name, device, id, flags)
  [pscustomobject]@{
    powerSource = switch ($power.ToString()) { 'Online' { 'mains' } 'Offline' { 'battery' } default { 'unknown' } }
    display = @{ name = $screen.DeviceName; logicalWidth = $screen.Bounds.Width; logicalHeight = $screen.Bounds.Height }
    gpu = @{ drawing = $null; adapters = $adapters }
  } | ConvertTo-Json -Depth 5 -Compress
}
