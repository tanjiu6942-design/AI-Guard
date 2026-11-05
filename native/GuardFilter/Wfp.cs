using System.ComponentModel;
using System.Runtime.InteropServices;

// Declarations match Windows SDK 10.0.26100 fwptypes.h/fwpmtypes.h/fwpmu.h,
// default MSVC x64 packing. --self-test checks the ABI before any WFP call.
internal static class Wfp
{
    public const uint FilterNotFound = 0x80320003, ProviderNotFound = 0x80320005, SublayerNotFound = 0x80320007;
    public const uint Persistent = 1, Block = 0x1001, ByteBlob = 12, UInt32 = 3;
    public const uint NotEqual = 10, Equal = 0, NoneSet = 8, Loopback = 1;
    public static readonly Guid AppId = new("d78e1e87-8644-4ea5-9437-d809ecefc971");
    public static readonly Guid Flags = new("632ce23b-5167-435c-86d7-e903684aa80c");

    [StructLayout(LayoutKind.Sequential)] public struct Display { public IntPtr Name, Description; }
    [StructLayout(LayoutKind.Sequential)] public struct Blob { public uint Size; public IntPtr Data; }
    [StructLayout(LayoutKind.Explicit, Size = 8)] public struct Data
    {
        [FieldOffset(0)] public IntPtr Pointer;
        [FieldOffset(0)] public uint UInt32;
        [FieldOffset(0)] public byte UInt8;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Value { public uint Type; public Data Data; }
    [StructLayout(LayoutKind.Sequential)] public struct Condition { public Guid Key; public uint Match; public Value Value; }
    [StructLayout(LayoutKind.Sequential)] public struct Action { public uint Type; public Guid Key; }
    [StructLayout(LayoutKind.Explicit, Size = 16)] public struct Context
    {
        [FieldOffset(0)] public ulong Raw;
        [FieldOffset(0)] public Guid Provider;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Filter
    {
        public Guid Key;
        public Display Display;
        public uint Flags;
        public IntPtr ProviderKey;
        public Blob ProviderData;
        public Guid LayerKey, SublayerKey;
        public Value Weight;
        public uint ConditionCount;
        public IntPtr Conditions;
        public Action Action;
        public Context Context;
        public IntPtr Reserved;
        public ulong Id;
        public Value EffectiveWeight;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Provider
    {
        public Guid Key;
        public Display Display;
        public uint Flags;
        public Blob ProviderData;
        public IntPtr ServiceName;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Sublayer
    {
        public Guid Key;
        public Display Display;
        public uint Flags;
        public IntPtr ProviderKey;
        public Blob ProviderData;
        public ushort Weight;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Session
    {
        public Guid Key;
        public Display Display;
        public uint Flags, Timeout, ProcessId;
        public IntPtr Sid, Username;
        public int KernelMode;
    }

    [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode)] public static extern uint FwpmEngineOpen0(string? server, uint auth, IntPtr identity, ref Session session, out IntPtr engine);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmEngineClose0(IntPtr engine);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmTransactionBegin0(IntPtr engine, uint flags);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmTransactionCommit0(IntPtr engine);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmTransactionAbort0(IntPtr engine);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmProviderAdd0(IntPtr engine, ref Provider provider, IntPtr security);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmProviderGetByKey0(IntPtr engine, ref Guid key, out IntPtr provider);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmProviderDeleteByKey0(IntPtr engine, ref Guid key);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmSubLayerAdd0(IntPtr engine, ref Sublayer sublayer, IntPtr security);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmSubLayerGetByKey0(IntPtr engine, ref Guid key, out IntPtr sublayer);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmSubLayerDeleteByKey0(IntPtr engine, ref Guid key);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmFilterAdd0(IntPtr engine, ref Filter filter, IntPtr security, out ulong id);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmFilterGetByKey0(IntPtr engine, ref Guid key, out IntPtr filter);
    [DllImport("fwpuclnt.dll")] public static extern uint FwpmFilterDeleteByKey0(IntPtr engine, ref Guid key);
    [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode)] public static extern uint FwpmGetAppIdFromFileName0(string path, out IntPtr appId);
    [DllImport("fwpuclnt.dll")] public static extern void FwpmFreeMemory0(ref IntPtr memory);

    public static void Check(uint code, string operation)
    {
        if (code != 0) throw new WfpException(code, operation);
    }
    public static byte[] Bytes(Blob blob)
    {
        if (blob.Size > 128 * 1024 || (blob.Size > 0 && blob.Data == IntPtr.Zero)) throw new InvalidOperationException("Invalid WFP byte blob");
        var bytes = new byte[blob.Size];
        if (bytes.Length > 0) Marshal.Copy(blob.Data, bytes, 0, bytes.Length);
        return bytes;
    }
}

internal sealed class WfpException(uint code, string operation)
    : Exception($"{operation}: {new Win32Exception(unchecked((int)code)).Message} (0x{code:X8})")
{
    public uint Code { get; } = code;
}

internal sealed class Arena : IDisposable
{
    readonly List<IntPtr> memory = [];
    public IntPtr Alloc(int size) { var p = Marshal.AllocHGlobal(size); memory.Add(p); return p; }
    public IntPtr Struct<T>(T value) where T : struct
    {
        var p = Alloc(Marshal.SizeOf<T>()); Marshal.StructureToPtr(value, p, false); return p;
    }
    public IntPtr Text(string value) { var p = Marshal.StringToHGlobalUni(value); memory.Add(p); return p; }
    public Wfp.Display Display(string name) => new() { Name = Text(name), Description = Text("AI Guard network lock v1") };
    public Wfp.Blob Bytes(byte[] bytes)
    {
        var p = Alloc(bytes.Length); Marshal.Copy(bytes, 0, p, bytes.Length);
        return new() { Size = (uint)bytes.Length, Data = p };
    }
    public IntPtr AppBlob(byte[] appId) => Struct(Bytes(appId));
    public void Dispose() { foreach (var p in memory) Marshal.FreeHGlobal(p); memory.Clear(); }
}

internal sealed class Engine : IDisposable
{
    public IntPtr Handle { get; private set; }
    public Engine(bool dynamic = false)
    {
        var session = new Wfp.Session { Flags = dynamic ? 1u : 0u, Timeout = 5000 };
        Wfp.Check(Wfp.FwpmEngineOpen0(null, 10 /* RPC_C_AUTHN_WINNT */, IntPtr.Zero, ref session, out var handle), "Open BFE");
        Handle = handle;
    }
    public void Transaction(System.Action action, uint flags = 0)
    {
        Wfp.Check(Wfp.FwpmTransactionBegin0(Handle, flags), "Begin WFP transaction");
        bool committed = false;
        try
        {
            action();
            Wfp.Check(Wfp.FwpmTransactionCommit0(Handle), "Commit WFP transaction");
            committed = true;
        }
        finally { if (!committed) Wfp.FwpmTransactionAbort0(Handle); }
    }
    public void Dispose()
    {
        if (Handle != IntPtr.Zero) { Wfp.FwpmEngineClose0(Handle); Handle = IntPtr.Zero; }
    }
}
