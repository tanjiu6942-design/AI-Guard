using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

internal static class KernelStore
{
    static readonly SecurityIdentifier Administrators = new(WellKnownSidType.BuiltinAdministratorsSid, null);
    static readonly SecurityIdentifier SystemAccount = new(WellKnownSidType.LocalSystemSid, null);
    public static string RootPath => Path.Combine(ProgramData(), "AI Guard", "protected-kernel");

    static string ProgramData()
    {
        // Shell resolves the machine Known Folder. No environment variable or
        // caller-supplied destination can redirect elevated writes.
        var folder = new Guid("62ab5d82-fdc1-4dc3-a9dd-070d1d495d97");
        int error = SHGetKnownFolderPath(ref folder, 0, IntPtr.Zero, out var p);
        if (error != 0) Marshal.ThrowExceptionForHR(error);
        try { return CanonicalLocalPath(Marshal.PtrToStringUni(p) ?? ""); }
        finally { Marshal.FreeCoTaskMem(p); }
    }
    internal static string CanonicalLocalPath(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || !Regex.IsMatch(value, @"^[A-Za-z]:\\") ||
            value.Contains('/') || value.IndexOf(':', 2) >= 0 || value.Contains('\0'))
            throw new ArgumentException("Kernel paths must be absolute local drive paths without streams or device prefixes");
        var pieces = value[3..].Split('\\');
        if (pieces.Any(p => p.Length == 0 || p is "." or ".." || p.EndsWith('.') || p.EndsWith(' ') || p.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0))
            throw new ArgumentException("Ambiguous kernel path component");
        var canonical = Path.GetFullPath(value);
        if (!string.Equals(canonical, value, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Kernel path must be canonical");
        return canonical;
    }
    internal static string ProtectedDigest(string path, string root)
    {
        var canonical = CanonicalLocalPath(path);
        var prefix = CanonicalLocalPath(root) + "\\";
        if (!canonical.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Kernel exception must be staged in the protected kernel directory");
        var relative = canonical[prefix.Length..].Split('\\');
        if (relative.Length != 2 || !Regex.IsMatch(relative[0], "^[a-f0-9]{64}$") || relative[1] != "mihomo.exe")
            throw new ArgumentException("Unexpected protected kernel hash path");
        return relative[0];
    }
    internal static string RuntimeKernel(string path, string root)
    {
        path = CanonicalLocalPath(path);
        if (!Regex.IsMatch(Path.GetFileName(path), "^runtime-[a-f0-9]{32}$")) throw new ArgumentException("Unexpected private runtime directory name");
        var kernel = Path.Combine(Path.GetDirectoryName(path)!, "mihomo.exe");
        ProtectedDigest(kernel, root);
        return kernel;
    }
    internal static void ValidateConfigName(string name)
    {
        if (!Regex.IsMatch(name, @"\Adesktop-[A-Za-z0-9_-]{1,80}\.yaml\z")) throw new ArgumentException("Invalid private configuration filename");
    }

    internal static DirectorySecurity DirectoryAcl()
    {
        var security = new DirectorySecurity();
        SetAcl(security, true);
        return security;
    }
    internal static FileSecurity FileAcl()
    {
        var security = new FileSecurity();
        SetAcl(security, false);
        return security;
    }
    static void SetAcl(FileSystemSecurity security, bool directory)
    {
        security.SetOwner(Administrators);
        security.SetGroup(Administrators);
        security.SetAccessRuleProtection(true, false);
        foreach (var sid in new[] { SystemAccount, Administrators })
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None,
                PropagationFlags.None, AccessControlType.Allow));
    }
    internal static void ValidateAcl(FileSystemSecurity security, bool directory)
    {
        var raw = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
        if (!security.AreAccessRulesProtected || raw.DiscretionaryAcl is null || raw.DiscretionaryAcl.Count != 2 ||
            (security.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner) ||
            (!owner.Equals(Administrators) && !owner.Equals(SystemAccount)))
            throw new UnauthorizedAccessException("Protected kernel owner/DACL must be SYSTEM or Administrators with inheritance disabled");
        var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToArray();
        if (rules.Length != 2) throw new UnauthorizedAccessException("Unsupported protected kernel ACL");
        foreach (var sid in new[] { Administrators, SystemAccount })
        {
            var matches = rules.Where(r => r.IdentityReference.Equals(sid)).ToArray();
            if (matches.Length != 1 || matches[0].AccessControlType != AccessControlType.Allow || matches[0].IsInherited ||
                matches[0].FileSystemRights != FileSystemRights.FullControl || matches[0].PropagationFlags != PropagationFlags.None ||
                matches[0].InheritanceFlags != (directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None))
                throw new UnauthorizedAccessException("Only SYSTEM and Administrators may access the protected kernel");
        }
    }
    internal static void AssertAttributes(FileAttributes attributes, bool directory)
    {
        if ((attributes & FileAttributes.ReparsePoint) != 0 || ((attributes & FileAttributes.Directory) != 0) != directory)
            throw new UnauthorizedAccessException("Kernel paths cannot contain reparse points or unexpected object types");
    }

    public sealed class PathLease : IDisposable
    {
        internal readonly List<SafeFileHandle> Handles = [];
        FileStream? stream;
        internal FileStream Stream => stream ??= new FileStream(Handles[^1], FileAccess.Read, 64 * 1024);
        public void Dispose()
        {
            stream?.Dispose();
            for (int i = Handles.Count - 1; i >= 0; i--) Handles[i].Dispose();
        }
    }
    static PathLease PinPath(string path, bool directory)
    {
        path = CanonicalLocalPath(path);
        var lease = new PathLease();
        try
        {
            string current = Path.GetPathRoot(path)!;
            Pin(current, true, lease);
            var pieces = path[3..].Split('\\');
            for (int i = 0; i < pieces.Length; i++)
            {
                current = Path.Combine(current, pieces[i]);
                Pin(current, i < pieces.Length - 1 || directory, lease);
            }
            return lease;
        }
        catch { lease.Dispose(); throw; }
    }
    static void Pin(string path, bool directory, PathLease lease)
    {
        AssertAttributes(File.GetAttributes(path), directory);
        // OPEN_REPARSE_POINT opens the link itself rather than following it.
        // No FILE_SHARE_DELETE pins every ancestor against rename/replacement.
        uint access = directory ? 0x00020080u /* READ_CONTROL | READ_ATTRIBUTES */ : 0x80020080u /* plus GENERIC_READ */;
        var handle = CreateFileW(path, access, directory ? 3u : 1u, IntPtr.Zero, 3,
            0x00200000u | (directory ? 0x02000000u : 0), IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot pin kernel path"); }
        lease.Handles.Add(handle);
        if (!GetFileInformationByHandle(handle, out var info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        AssertAttributes((FileAttributes)info.Attributes, directory);
        var final = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
        if (length == 0 || length >= final.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot resolve pinned kernel path");
        if (!string.Equals(final.ToString().TrimEnd('\\'), (@"\\?\" + path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("Kernel path was redirected");
        if (!directory && info.NumberOfLinks != 1) throw new UnauthorizedAccessException("Protected/staged kernel cannot be a hard-linked file");
    }
    static string Digest(PathLease lease)
    {
        var stream = lease.Stream;
        stream.Position = 0;
        var hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        stream.Position = 0;
        return hash;
    }
    static PathLease PrivateDirectory(string path)
    {
        // Create applies a protected DACL and Administrators owner atomically.
        // If already present, it changes nothing; then strict validation rejects
        // user-owned/insecure preplants instead of taking them over as admin.
        new DirectoryInfo(path).Create(DirectoryAcl());
        var lease = PinPath(path, true);
        try { ValidateAcl(new DirectoryInfo(path).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner), true); return lease; }
        catch { lease.Dispose(); throw; }
    }
    public static PathLease OpenProtected(string path)
    {
        var root = RootPath;
        var expectedHash = ProtectedDigest(path, root);
        var lease = PinPath(path, false);
        try
        {
            foreach (var directory in new[] { Path.GetDirectoryName(root)!, root, Path.GetDirectoryName(path)! })
                ValidateAcl(new DirectoryInfo(directory).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner), true);
            ValidateAcl(new FileInfo(path).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner), false);
            if (Digest(lease) != expectedHash) throw new InvalidOperationException("Protected kernel SHA256 does not match its directory");
            return lease;
        }
        catch { lease.Dispose(); throw; }
    }
    public static string Stage(string source)
    {
        source = CanonicalLocalPath(source);
        using var sourceLease = OpenSource(source);
        string hash = Digest(sourceLease);
        string programData = ProgramData();
        using var programDataLease = PinPath(programData, true);
        string appRoot = Path.Combine(programData, "AI Guard");
        using var appLease = PrivateDirectory(appRoot);
        string root = Path.Combine(appRoot, "protected-kernel");
        using var rootLease = PrivateDirectory(root);
        string directory = Path.Combine(root, hash);
        using var hashLease = PrivateDirectory(directory);
        string destination = Path.Combine(directory, "mihomo.exe");
        if (File.Exists(destination)) { using var existing = OpenProtected(destination); return destination; }
        string temporary = Path.Combine(directory, ".stage-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (var output = new FileInfo(temporary).Create(FileMode.CreateNew, FileSystemRights.FullControl,
                FileShare.None, 64 * 1024, FileOptions.WriteThrough, FileAcl()))
            {
                sourceLease.Stream.CopyTo(output);
                output.Flush(true);
                output.Position = 0;
                if (Convert.ToHexString(SHA256.HashData(output)).ToLowerInvariant() != hash)
                    throw new InvalidOperationException("Kernel changed while staging; copied SHA256 mismatch");
            }
            // Atomic rename, never overwrite a pre-existing image or a running
            // version. Concurrent staging is safe if the winner is valid.
            try { File.Move(temporary, destination, false); }
            catch (IOException) when (File.Exists(destination)) { using var winner = OpenProtected(destination); }
            using var final = OpenProtected(destination);
            return destination;
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    internal static PathLease OpenSource(string source)
    {
        source = CanonicalLocalPath(source);
        if (!source.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Kernel source must be an existing .exe file");
        return PinPath(source, false);
    }

    public static string PrepareRuntime(string kernel)
    {
        using var imageLease = OpenProtected(kernel);
        string directory = Path.Combine(Path.GetDirectoryName(kernel)!, "runtime-" + Guid.NewGuid().ToString("N"));
        using var runtimeLease = PrivateDirectory(directory);
        return directory;
    }
    public static string WriteConfig(string runtime, string name, Stream input)
    {
        string kernel = RuntimeKernel(runtime, RootPath);
        ValidateConfigName(name);
        using var imageLease = OpenProtected(kernel);
        using var runtimeLease = PinPath(runtime, true);
        ValidateAcl(new DirectoryInfo(runtime).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner), true);
        // Read secrets only from the inherited stdin pipe. Never put YAML into
        // command-line arguments, public temp files, JSON output or errors.
        using var bytes = new MemoryStream();
        var buffer = new byte[65536];
        int count;
        while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
        {
            if (bytes.Length + count > 16 * 1024 * 1024) throw new ArgumentException("Private configuration exceeds 16 MiB");
            bytes.Write(buffer, 0, count);
        }
        var content = bytes.ToArray();
        new UTF8Encoding(false, true).GetCharCount(content); // reject malformed UTF-8
        string destination = Path.Combine(runtime, name);
        if (File.Exists(destination) || Directory.Exists(destination)) throw new IOException("Private configuration already exists; use a new random name");
        string temporary = Path.Combine(runtime, ".stage-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (var output = new FileInfo(temporary).Create(FileMode.CreateNew, FileSystemRights.FullControl,
                FileShare.None, 64 * 1024, FileOptions.WriteThrough, FileAcl()))
            {
                output.Write(content);
                output.Flush(true);
            }
            File.Move(temporary, destination, false);
            using var configLease = PinPath(destination, false);
            ValidateAcl(new FileInfo(destination).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner), false);
            return destination;
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    [StructLayout(LayoutKind.Sequential)] struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, AccessTime, WriteTime;
        public uint VolumeSerialNumber, SizeHigh, SizeLow, NumberOfLinks, IndexHigh, IndexLow;
    }
    [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
}
