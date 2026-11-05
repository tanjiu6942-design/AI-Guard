using System.Runtime.InteropServices;
using System.Text;

internal record GuardIds(Guid Provider, Guid Sublayer, Guid[] Filters, Guid[] Layers);
internal record GuardStatus(bool Locked, bool Complete, int FilterCount, string[] Errors, bool Available = true);

internal static class Guard
{
    internal static readonly GuardIds Identity = new(
        new("a18d0d32-256e-4c72-a197-567936f337a0"),
        new("f8afc1bd-bc1f-4653-bfcb-6be5f8551612"),
        [new("d4e638f0-d1f5-4df3-835d-c32149795b01"), new("d4e638f0-d1f5-4df3-835d-c32149795b02"),
         new("d4e638f0-d1f5-4df3-835d-c32149795b03"), new("d4e638f0-d1f5-4df3-835d-c32149795b04")],
        [new("c38d57d1-05a7-4c33-904f-7fbceee60e82"), new("4a72393b-319f-44bc-84c3-ba54dcb3b6b4"),
         new("e1cd9fe7-f4b5-4273-96c0-592e487b8650"), new("a3b42c97-9f04-4672-b87e-cee9c483257f")]);
    static readonly byte[] Marker = Encoding.UTF8.GetBytes("AI-GUARD/WFP/V1");

    public static Wfp.Filter BuildFilter(Arena arena, Guid key, Guid layer, IntPtr appId, GuardIds ids, bool isolated)
    {
        if (appId == IntPtr.Zero) throw new InvalidOperationException("Missing application ID");
        var conditions = arena.Alloc(Marshal.SizeOf<Wfp.Condition>() * 2);
        Marshal.StructureToPtr(new Wfp.Condition {
            Key = Wfp.AppId, Match = isolated ? Wfp.Equal : Wfp.NotEqual,
            Value = new() { Type = Wfp.ByteBlob, Data = new() { Pointer = appId } }
        }, conditions, false);
        Marshal.StructureToPtr(new Wfp.Condition {
            Key = Wfp.Flags, Match = Wfp.NoneSet,
            Value = new() { Type = Wfp.UInt32, Data = new() { UInt32 = Wfp.Loopback } }
        }, conditions + Marshal.SizeOf<Wfp.Condition>(), false);
        return new() {
            Key = key, Display = arena.Display(isolated ? "AI Guard isolated self-test" : "AI Guard network lock"),
            Flags = isolated ? 0 : Wfp.Persistent, ProviderKey = arena.Struct(ids.Provider),
            ProviderData = arena.Bytes(Marker), LayerKey = layer, SublayerKey = ids.Sublayer,
            Weight = new() { Type = 1 /* FWP_UINT8 */, Data = new() { UInt8 = 15 } },
            ConditionCount = 2, Conditions = conditions, Action = new() { Type = Wfp.Block }
        };
    }

    static bool ProviderMatches(IntPtr key, Guid expected) => key != IntPtr.Zero && Marshal.PtrToStructure<Guid>(key) == expected;
    static void Owned(Wfp.Blob blob)
    {
        if (!Wfp.Bytes(blob).SequenceEqual(Marker)) throw new InvalidOperationException("WFP object ownership marker mismatch; no object was removed");
    }
    public static void ValidateFilter(Wfp.Filter f, GuardIds ids, Guid layer, bool isolated)
    {
        ValidateOwner(f, ids);
        if ((!isolated && f.Key != ids.Filters[Array.IndexOf(ids.Layers, layer)]) || f.LayerKey != layer ||
            f.Action.Type != Wfp.Block || (f.Flags & (Wfp.Persistent | 0x20)) != (isolated ? 0u : Wfp.Persistent) ||
            f.ConditionCount != 2 || f.Conditions == IntPtr.Zero)
            throw new InvalidOperationException("Incomplete, disabled or unexpected AI Guard filter");
        var app = Marshal.PtrToStructure<Wfp.Condition>(f.Conditions);
        var flags = Marshal.PtrToStructure<Wfp.Condition>(f.Conditions + Marshal.SizeOf<Wfp.Condition>());
        if (app.Key != Wfp.AppId || app.Match != (isolated ? Wfp.Equal : Wfp.NotEqual) || app.Value.Type != Wfp.ByteBlob ||
            flags.Key != Wfp.Flags || flags.Match != Wfp.NoneSet || flags.Value.Type != Wfp.UInt32 || flags.Value.Data.UInt32 != Wfp.Loopback)
            throw new InvalidOperationException("Unexpected AI Guard application/loopback conditions");
        if (ReadAppId(f).Length < 4) throw new InvalidOperationException("Empty AI Guard application exception");
    }
    static void ValidateOwner(Wfp.Filter f, GuardIds ids)
    {
        if (!ProviderMatches(f.ProviderKey, ids.Provider) || f.SublayerKey != ids.Sublayer)
            throw new InvalidOperationException("Foreign WFP object at AI Guard filter ID; no object was removed");
        Owned(f.ProviderData);
    }
    public static byte[] ReadAppId(Wfp.Filter f)
    {
        var c = Marshal.PtrToStructure<Wfp.Condition>(f.Conditions);
        if (c.Value.Data.Pointer == IntPtr.Zero) throw new InvalidOperationException("Missing WFP application blob");
        return Wfp.Bytes(Marshal.PtrToStructure<Wfp.Blob>(c.Value.Data.Pointer));
    }
    public static byte[] AppId(string path)
    {
        if (!Path.IsPathFullyQualified(path) || !File.Exists(path) || !path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("--allow-app requires an existing absolute .exe path");
        Wfp.Check(Wfp.FwpmGetAppIdFromFileName0(Path.GetFullPath(path), out var p), "Resolve kernel application ID");
        try { return Wfp.Bytes(Marshal.PtrToStructure<Wfp.Blob>(p)); }
        finally { Wfp.FwpmFreeMemory0(ref p); }
    }

    static bool Provider(Engine engine, GuardIds ids, bool isolated = false)
    {
        var key = ids.Provider;
        var code = Wfp.FwpmProviderGetByKey0(engine.Handle, ref key, out var p);
        if (code == Wfp.ProviderNotFound) return false;
        Wfp.Check(code, "Query AI Guard provider");
        try {
            var value = Marshal.PtrToStructure<Wfp.Provider>(p); Owned(value.ProviderData);
            if (value.Key != key || (!isolated && ((value.Flags & (Wfp.Persistent | 0x10)) != Wfp.Persistent ||
                Marshal.PtrToStringUni(value.ServiceName) != "BFE")))
                throw new InvalidOperationException("AI Guard provider is disabled or not persistent");
            return true;
        } finally { Wfp.FwpmFreeMemory0(ref p); }
    }
    static bool Sublayer(Engine engine, GuardIds ids, bool isolated = false)
    {
        var key = ids.Sublayer;
        var code = Wfp.FwpmSubLayerGetByKey0(engine.Handle, ref key, out var p);
        if (code == Wfp.SublayerNotFound) return false;
        Wfp.Check(code, "Query AI Guard sublayer");
        try {
            var value = Marshal.PtrToStructure<Wfp.Sublayer>(p); Owned(value.ProviderData);
            if (value.Key != key || !ProviderMatches(value.ProviderKey, ids.Provider) || (!isolated && (value.Flags & Wfp.Persistent) == 0))
                throw new InvalidOperationException("Foreign or nonpersistent AI Guard sublayer");
            return true;
        } finally { Wfp.FwpmFreeMemory0(ref p); }
    }
    public static GuardStatus Status(Engine engine)
    {
        int count = 0;
        var errors = new List<string>();
        byte[]? app = null;
        bool provider = false, sublayer = false;
        try { provider = Provider(engine, Identity); } catch (InvalidOperationException ex) { errors.Add(ex.Message); }
        try { sublayer = Sublayer(engine, Identity); } catch (InvalidOperationException ex) { errors.Add(ex.Message); }
        foreach (var (keyValue, layer) in Identity.Filters.Zip(Identity.Layers))
        {
            var key = keyValue;
            var code = Wfp.FwpmFilterGetByKey0(engine.Handle, ref key, out var p);
            if (code == Wfp.FilterNotFound) continue;
            Wfp.Check(code, "Query AI Guard filter"); count++;
            try {
                var value = Marshal.PtrToStructure<Wfp.Filter>(p);
                ValidateFilter(value, Identity, layer, false);
                var candidate = ReadAppId(value);
                if (app is not null && !app.SequenceEqual(candidate)) errors.Add("AI Guard application exceptions differ between layers");
                app = candidate;
            } catch (InvalidOperationException ex) { errors.Add(ex.Message); }
            finally { Wfp.FwpmFreeMemory0(ref p); }
        }
        if (count > 0 && (!provider || !sublayer)) errors.Add("AI Guard provider/sublayer missing or invalid");
        if (count > 0 && count != Identity.Filters.Length) errors.Add("AI Guard IPv4/IPv6 filter set incomplete");
        return new(count > 0 || errors.Count > 0, errors.Count == 0, count, errors.ToArray());
    }
    internal static void AddMetadata(Engine engine, Arena arena, GuardIds ids, bool isolated)
    {
        if (!Provider(engine, ids, isolated))
        {
            var provider = new Wfp.Provider {
                Key = ids.Provider, Display = arena.Display("AI Guard"), Flags = isolated ? 0 : Wfp.Persistent,
                ProviderData = arena.Bytes(Marker),
                // BFE is already an auto-start service. Association allows our
                // persistent filters to remain enabled after restart. No service
                // is installed, modified or started by this helper.
                ServiceName = isolated ? IntPtr.Zero : arena.Text("BFE")
            };
            Wfp.Check(Wfp.FwpmProviderAdd0(engine.Handle, ref provider, IntPtr.Zero), "Add AI Guard provider");
        }
        if (!Sublayer(engine, ids, isolated))
        {
            var sublayer = new Wfp.Sublayer {
                Key = ids.Sublayer, Display = arena.Display("AI Guard network lock"), Flags = isolated ? 0 : Wfp.Persistent,
                ProviderKey = arena.Struct(ids.Provider), ProviderData = arena.Bytes(Marker), Weight = 0xFFFF
            };
            Wfp.Check(Wfp.FwpmSubLayerAdd0(engine.Handle, ref sublayer, IntPtr.Zero), "Add AI Guard sublayer");
        }
    }
    static void DeleteFilters(Engine engine)
    {
        foreach (var keyValue in Identity.Filters)
        {
            var key = keyValue;
            var code = Wfp.FwpmFilterGetByKey0(engine.Handle, ref key, out var p);
            if (code == Wfp.FilterNotFound) continue;
            Wfp.Check(code, "Query filter before removal");
            try { ValidateOwner(Marshal.PtrToStructure<Wfp.Filter>(p), Identity); }
            finally { Wfp.FwpmFreeMemory0(ref p); }
            Wfp.Check(Wfp.FwpmFilterDeleteByKey0(engine.Handle, ref key), "Remove AI Guard filter");
        }
    }
    public static GuardStatus Lock(Engine engine, string path)
    {
        // ALE_APP_ID is a path identity, not a process identity. A world-readable
        // executable would let another ordinary process launch the same image
        // and inherit our exception, bypassing the controlled worker's policy.
        using var protectedKernel = KernelStore.OpenProtected(path);
        var app = AppId(path);
        using var arena = new Arena();
        engine.Transaction(() => {
            AddMetadata(engine, arena, Identity, false);
            DeleteFilters(engine);
            var blob = arena.AppBlob(app);
            foreach (var (key, layer) in Identity.Filters.Zip(Identity.Layers))
            {
                var f = BuildFilter(arena, key, layer, blob, Identity, false);
                Wfp.Check(Wfp.FwpmFilterAdd0(engine.Handle, ref f, IntPtr.Zero, out _), "Add AI Guard filter");
            }
        });
        var result = Status(engine);
        if (!result.Locked || !result.Complete || result.FilterCount != 4) throw new InvalidOperationException("AI Guard lock verification failed");
        return result;
    }
    public static GuardStatus Unlock(Engine engine)
    {
        engine.Transaction(() => {
            // Validate ownership of metadata too; never enumerate/delete another
            // provider's filters or guess at names.
            var hasProvider = Provider(engine, Identity, true);
            var hasSublayer = Sublayer(engine, Identity, true);
            DeleteFilters(engine);
            var sublayer = Identity.Sublayer; var provider = Identity.Provider;
            if (hasSublayer) Wfp.Check(Wfp.FwpmSubLayerDeleteByKey0(engine.Handle, ref sublayer), "Remove AI Guard sublayer");
            if (hasProvider) Wfp.Check(Wfp.FwpmProviderDeleteByKey0(engine.Handle, ref provider), "Remove AI Guard provider");
        });
        var result = Status(engine);
        if (result.Locked || !result.Complete || Provider(engine, Identity, true) || Sublayer(engine, Identity, true))
            throw new InvalidOperationException("AI Guard unlock verification failed");
        return result;
    }
}
