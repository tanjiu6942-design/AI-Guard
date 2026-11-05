using System.Security.AccessControl;
using System.Security.Principal;

internal static class KernelStoreTests
{
    public static void Run()
    {
        // Exercise the actual Win32 no-reparse/pinned-handle read path, safely
        // against our own readable executable. This creates/modifies no files.
        using (var executable = KernelStore.OpenSource(Environment.ProcessPath!))
        {
            if (executable.Stream.ReadByte() != 0x4d || executable.Stream.ReadByte() != 0x5a)
                throw new Exception("Pinned source did not read a PE executable");
        }
        const string root = @"C:\ProgramData\AI Guard\protected-kernel";
        string digest = new('a', 64);
        string valid = $@"{root}\{digest}\mihomo.exe";
        if (KernelStore.ProtectedDigest(valid, root) != digest) throw new Exception("Protected path digest mismatch");
        foreach (var path in new[] {
            @"C:\shared\mihomo.exe", $@"{root}-other\{digest}\mihomo.exe", $@"{root}\..\{digest}\mihomo.exe",
            $@"{root}\{digest}\mihomo.exe:payload", $@"{root}\{digest}\other.exe", $@"{root}\bad\mihomo.exe",
            $@"{root}\{digest}\mihomo.exe.", @"\\server\share\mihomo.exe", @"\\?\C:\shared\mihomo.exe", "mihomo.exe" })
            Reject(() => KernelStore.ProtectedDigest(path, root), "untrusted kernel path");
        string runtime = $@"{root}\{digest}\runtime-{new string('b', 32)}";
        if (KernelStore.RuntimeKernel(runtime, root) != valid) throw new Exception("Runtime kernel mismatch");
        foreach (var path in new[] { root, $@"{root}\{digest}\runtime-bad", runtime + @"\child", runtime.Replace("runtime-", "public-") })
            Reject(() => KernelStore.RuntimeKernel(path, root), "untrusted runtime path");
        KernelStore.ValidateConfigName("desktop-main-123.yaml");
        foreach (var name in new[] { "../escape.yaml", "desktop-a.yaml:stream", "desktop-a.yaml.", "other.yaml", "desktop-.yaml", "desktop-a/b.yaml" })
            Reject(() => KernelStore.ValidateConfigName(name), "unsafe private config filename");
        KernelStore.AssertAttributes(FileAttributes.Directory, true);
        KernelStore.AssertAttributes(FileAttributes.Archive, false);
        Reject(() => KernelStore.AssertAttributes(FileAttributes.Directory | FileAttributes.ReparsePoint, true), "directory reparse point");
        Reject(() => KernelStore.AssertAttributes(FileAttributes.ReparsePoint, false), "file reparse point");
        Reject(() => KernelStore.AssertAttributes(FileAttributes.Directory, false), "directory as executable");
        var directory = KernelStore.DirectoryAcl();
        KernelStore.ValidateAcl(directory, true);
        KernelStore.ValidateAcl(KernelStore.FileAcl(), false);
        foreach (var sid in new[] { WellKnownSidType.WorldSid, WellKnownSidType.AuthenticatedUserSid, WellKnownSidType.BuiltinUsersSid })
        {
            var unsafeAcl = KernelStore.DirectoryAcl();
            unsafeAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid, null), FileSystemRights.ReadAndExecute, AccessControlType.Allow));
            Reject(() => KernelStore.ValidateAcl(unsafeAcl, true), "ordinary-user execute ACE");
        }
        var inherited = KernelStore.DirectoryAcl(); inherited.SetAccessRuleProtection(false, true);
        Reject(() => KernelStore.ValidateAcl(inherited, true), "inheriting directory ACL");
        var wrongOwner = KernelStore.DirectoryAcl(); wrongOwner.SetOwner(new SecurityIdentifier(WellKnownSidType.WorldSid, null));
        Reject(() => KernelStore.ValidateAcl(wrongOwner, true), "untrusted directory owner");
        var nullDacl = new DirectorySecurity(); nullDacl.SetSecurityDescriptorSddlForm("O:BAG:BAD:NO_ACCESS_CONTROL");
        Reject(() => KernelStore.ValidateAcl(nullDacl, true), "null DACL");
        var empty = new DirectorySecurity(); empty.SetSecurityDescriptorSddlForm("O:BAG:BAD:P");
        Reject(() => KernelStore.ValidateAcl(empty, true), "missing admin access");
    }
    static void Reject(Action action, string name)
    {
        try { action(); } catch (ArgumentException) { return; } catch (InvalidOperationException) { return; } catch (UnauthorizedAccessException) { return; }
        throw new InvalidOperationException("KernelStore self-test accepted " + name);
    }
}
