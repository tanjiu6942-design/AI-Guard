using System.Security.Principal;
using System.Text.Json;
using Microsoft.Win32;

internal static class Program
{
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    static int Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindowsVersionAtLeast(10) || IntPtr.Size != 8) throw new PlatformNotSupportedException("Windows 10/11 x64 is required");
            var selfTest = SelfTest.Run();
            if (args.SequenceEqual(new[] { "--self-test" })) { Print(selfTest); return 0; }
            if (args.SequenceEqual(new[] { "--test-isolated" })) { RequireAdministrator(); Print(IsolatedTest.Run()); return 0; }
            bool status = args.SequenceEqual(new[] { "status" });
            bool check = args.SequenceEqual(new[] { "check" });
            bool unlock = args.SequenceEqual(new[] { "unlock" });
            bool lockCommand = args.Length == 3 && args[0] == "lock" && args[1] == "--allow-app";
            bool stageKernel = args.Length == 3 && args[0] == "stage-kernel" && args[1] == "--source";
            bool prepareRuntime = args.Length == 3 && args[0] == "prepare-runtime" && args[1] == "--kernel";
            bool writeConfig = args.Length == 5 && args[0] == "write-config" && args[1] == "--runtime" && args[3] == "--name";
            if (!status && !check && !unlock && !lockCommand && !stageKernel && !prepareRuntime && !writeConfig)
                throw new ArgumentException("Usage: status | check | stage-kernel --source <absolute.exe> | prepare-runtime --kernel <protected.exe> | write-config --runtime <private-dir> --name <desktop-*.yaml> (stdin UTF-8) | lock --allow-app <protected.exe> | unlock | --self-test | --test-isolated");
            if (!status) RequireAdministrator();
            if (check || lockCommand)
            {
                using var serviceKey = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\BFE");
                if (serviceKey?.GetValue("Start") is not int start || start != 2) throw new InvalidOperationException("BFE must already be configured for automatic startup; no service settings were changed");
            }
            using var engine = new Engine();
            if (stageKernel)
            {
                var current = Guard.Status(engine);
                var path = KernelStore.Stage(args[2]);
                Print(new { current.Locked, current.Complete, current.FilterCount, current.Errors, current.Available,
                    kernelPath = path, sha256 = Path.GetFileName(Path.GetDirectoryName(path)) });
                return 0;
            }
            if (prepareRuntime)
            {
                var current = Guard.Status(engine);
                var directory = KernelStore.PrepareRuntime(args[2]);
                Print(new { current.Locked, current.Complete, current.FilterCount, current.Errors, current.Available, runtimeDir = directory });
                return 0;
            }
            if (writeConfig)
            {
                var current = Guard.Status(engine);
                using var input = Console.OpenStandardInput();
                var path = KernelStore.WriteConfig(args[2], args[4], input);
                Print(new { current.Locked, current.Complete, current.FilterCount, current.Errors, current.Available, path });
                return 0;
            }
            GuardStatus result;
            if (lockCommand) result = Guard.Lock(engine, args[2]);
            else if (unlock) result = Guard.Unlock(engine);
            else
            {
                // BeginTransaction requires write access even with READ_ONLY.
                // Individual get calls keep status usable by a normal caller;
                // a mixed/partial observation fails closed in Guard.Status.
                result = Guard.Status(engine);
                if (check && !result.Complete) throw new InvalidOperationException("AI Guard filter state is incomplete: " + string.Join("; ", result.Errors));
            }
            Print(result);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(JsonSerializer.Serialize(new {
                error = ex.Message, code = ex is WfpException wfp ? $"0x{wfp.Code:X8}" : ex.GetType().Name
            }, Json));
            return 1;
        }
    }
    public static void RequireAdministrator()
    {
        using var identity = WindowsIdentity.GetCurrent();
        if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
            throw new UnauthorizedAccessException("Administrator elevation is required for kernel staging, WFP check, lock, unlock and isolated testing");
    }
    static void Print(object value) => Console.WriteLine(JsonSerializer.Serialize(value, Json));
}
