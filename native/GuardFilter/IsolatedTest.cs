using System.Net;
using System.Net.Sockets;

internal static class IsolatedTest
{
    public static object Run()
    {
        // No user-supplied app path and no persistent objects: only this exact
        // helper binary is matched, and closing/crashing releases every object.
        var ownPath = Environment.ProcessPath ?? throw new InvalidOperationException("Cannot resolve self executable");
        var appId = Guard.AppId(ownPath);
        var ids = new GuardIds(Guid.NewGuid(), Guid.NewGuid(),
            Enumerable.Range(0, 4).Select(_ => Guid.NewGuid()).ToArray(), Guard.Identity.Layers);
        using (var engine = new Engine(dynamic: true))
        using (var arena = new Arena())
        {
            engine.Transaction(() => {
                Guard.AddMetadata(engine, arena, ids, true);
                var blob = arena.AppBlob(appId);
                foreach (var (key, layer) in ids.Filters.Zip(ids.Layers))
                {
                    var filter = Guard.BuildFilter(arena, key, layer, blob, ids, true);
                    Wfp.Check(Wfp.FwpmFilterAdd0(engine.Handle, ref filter, IntPtr.Zero, out _), "Add isolated filter");
                }
            });
            Loopback(IPAddress.Loopback);
            Loopback(IPAddress.IPv6Loopback);
            Blocked(IPAddress.Parse("192.0.2.1"));
            Blocked(IPAddress.Parse("2001:db8::1"));
        }
        // Verify session cleanup by opening an independent read-only engine.
        using var verification = new Engine();
        foreach (var keyValue in ids.Filters)
        {
            var key = keyValue;
            var code = Wfp.FwpmFilterGetByKey0(verification.Handle, ref key, out var p);
            if (p != IntPtr.Zero) Wfp.FwpmFreeMemory0(ref p);
            if (code != Wfp.FilterNotFound) throw new InvalidOperationException("Isolated filter cleanup did not complete");
        }
        return new { ok = true, scope = "this executable only", ipv4 = true, ipv6 = true, loopback = true, cleaned = true };
    }
    static void Loopback(IPAddress address)
    {
        var listener = new TcpListener(address, 0);
        listener.Start();
        try
        {
            using var client = new TcpClient(address.AddressFamily);
            using var timeout = new CancellationTokenSource(3000);
            client.ConnectAsync(address, ((IPEndPoint)listener.LocalEndpoint).Port, timeout.Token).AsTask().GetAwaiter().GetResult();
            using var accepted = listener.AcceptTcpClientAsync(timeout.Token).AsTask().GetAwaiter().GetResult();
        }
        finally { listener.Stop(); }
    }
    static void Blocked(IPAddress address)
    {
        using var client = new TcpClient(address.AddressFamily);
        using var timeout = new CancellationTokenSource(3000);
        try { client.ConnectAsync(address, 9, timeout.Token).AsTask().GetAwaiter().GetResult(); }
        catch (SocketException ex) when (ex.SocketErrorCode == SocketError.AccessDenied) { return; }
        throw new InvalidOperationException($"Isolated {address.AddressFamily} connection was not denied by WFP");
    }
}
