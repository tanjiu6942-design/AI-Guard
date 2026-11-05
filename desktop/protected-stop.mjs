// Removing the TUN before a confirmed system lock would expose direct traffic.
//
// preserve 的语义: 退出时要"保留系统断流"(用户明确要求断着走)。
//
// 曾经这里把 preserve 与"内核正常退出"混在一起用: 程序关闭时传 preserve=true,
// 于是每次退出程序都会 trip() 一次整机断流。实测表现是 —— 关掉程序后重开,
// 界面立刻显示"已断流", 但 WFP 实际 filterCount=0(根本没锁), 网络也是通的:
// 状态被写成了 locked, 系统规则却没装上, 界面在撒谎。
//
// 现在区分两件事:
//   - 正常停止/退出程序: 不是危险事件, 内核退出即释放, 不该断流。
//   - 检测到泄漏后断流: 由 ProtectionMonitor.trip() 负责, 与退出流程无关。
export async function stopProtectedSession({ protection, session, preserve, reason }) {
  if (protection && preserve) {
    await protection.trip(reason);
    await protection.assertSystemLocked();
  }
  await protection?.shutdown();
  await session.stop();
  if (protection && !preserve) await protection.release();
}
