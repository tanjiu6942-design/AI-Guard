using System.Runtime.InteropServices;

internal static class SelfTest
{
    // These expected offsets come from the Windows SDK x64 C ABI, independently
    // of the managed declarations. No WFP engine is opened by this test.
    public static object Run()
    {
        KernelStoreTests.Run();
        Equal(Marshal.SizeOf<Wfp.Value>(), 16, "FWP_VALUE0 size");
        Equal(Marshal.SizeOf<Wfp.Blob>(), 16, "FWP_BYTE_BLOB size");
        Equal(Marshal.SizeOf<Wfp.Condition>(), 40, "FWPM_FILTER_CONDITION0 size");
        Equal(Marshal.SizeOf<Wfp.Filter>(), 200, "FWPM_FILTER0 size");
        Equal(Marshal.SizeOf<Wfp.Provider>(), 64, "FWPM_PROVIDER0 size");
        Equal(Marshal.SizeOf<Wfp.Sublayer>(), 72, "FWPM_SUBLAYER0 size");
        Equal(Marshal.SizeOf<Wfp.Session>(), 72, "FWPM_SESSION0 size");
        Equal(Marshal.OffsetOf<Wfp.Filter>(nameof(Wfp.Filter.Conditions)).ToInt32(), 120, "condition offset");
        Equal(Marshal.OffsetOf<Wfp.Filter>(nameof(Wfp.Filter.Action)).ToInt32(), 128, "action offset");
        Equal(Marshal.OffsetOf<Wfp.Filter>(nameof(Wfp.Filter.Context)).ToInt32(), 152, "context offset");
        Equal(Marshal.OffsetOf<Wfp.Filter>(nameof(Wfp.Filter.Id)).ToInt32(), 176, "id offset");
        using var arena = new Arena();
        byte[] appId = System.Text.Encoding.Unicode.GetBytes("\\device\\harddiskvolume1\\mihomo.exe\0");
        var blob = arena.AppBlob(appId);
        var ids = Guard.Identity;
        Equal(ids.Layers.Length, 4, "IPv4/IPv6 connect/accept layers");
        foreach (var (key, layer) in ids.Filters.Zip(ids.Layers))
        {
            var f = Guard.BuildFilter(arena, key, layer, blob, ids, false);
            Guard.ValidateFilter(f, ids, layer, false);
            Equal(Guard.ReadAppId(f).SequenceEqual(appId), true, "exact app exception");
            var appCondition = Marshal.PtrToStructure<Wfp.Condition>(f.Conditions);
            Equal(appCondition.Key, new Guid("d78e1e87-8644-4ea5-9437-d809ecefc971"), "ALE_APP_ID key");
            Equal(appCondition.Match, 10u, "NOT_EQUAL exception");
            Equal(appCondition.Value.Type, 12u, "app ID BYTE_BLOB");
            Equal(f.Action.Type, 0x1001u, "terminating BLOCK");
            Equal(f.Flags, 1u, "persistent filter");
            var flags = Marshal.PtrToStructure<Wfp.Condition>(f.Conditions + 40);
            Equal(flags.Match, 8u, "FLAGS_NONE_SET");
            Equal(flags.Value.Type, 3u, "flags UINT32");
            Equal(flags.Value.Data.UInt32, 1u, "IS_LOOPBACK");
            // A malformed ownership marker or missing safety condition must fail.
            var foreign = f; foreign.ProviderKey = IntPtr.Zero;
            Reject(() => Guard.ValidateFilter(foreign, ids, layer, false), "foreign ownership");
            var missing = f; missing.ConditionCount = 1;
            Reject(() => Guard.ValidateFilter(missing, ids, layer, false), "missing condition");
            var disabled = f; disabled.Flags |= 0x20;
            Reject(() => Guard.ValidateFilter(disabled, ids, layer, false), "disabled filter");
            var allow = f; allow.Action.Type = 0x1002;
            Reject(() => Guard.ValidateFilter(allow, ids, layer, false), "permit instead of block");
            var differentLayer = f; differentLayer.LayerKey = Guid.Empty;
            Reject(() => Guard.ValidateFilter(differentLayer, ids, layer, false), "different layer");
        }
        // The only live test policy is restricted to this executable, never a
        // NOT_EQUAL exception that could accidentally block another process.
        var scoped = Guard.BuildFilter(arena, Guid.NewGuid(), ids.Layers[0], blob, ids, true);
        Guard.ValidateFilter(scoped, ids, ids.Layers[0], true);
        var app = Marshal.PtrToStructure<Wfp.Condition>(scoped.Conditions);
        Equal(app.Match, 0u, "isolated mode uses EQUAL");
        Equal(scoped.Flags, 0u, "isolated mode never persistent");
        return new { ok = true, checkedLayers = 4, networkModified = false };
    }

    static void Equal<T>(T actual, T expected, string name) where T : IEquatable<T>
    {
        if (!actual.Equals(expected)) throw new InvalidOperationException($"Self-test {name}: expected {expected}, got {actual}");
    }
    static void Reject(Action action, string name)
    {
        try { action(); } catch (InvalidOperationException) { return; }
        throw new InvalidOperationException($"Self-test accepted {name}");
    }
}
