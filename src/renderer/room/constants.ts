/**
 * 房间控制器的共享常量与基础类型。
 * 各子系统（followerSync/hostSync/fileTransfer/relayPrefetch）按需取用。
 */

/** 房间角色 */
export type Role = 'host' | 'follower'

/** 成员端断线判定阈值（ms）：超过该时长未收到房主 state 心跳即视为连接断开 */
export const STATE_TIMEOUT_MS = 8000

/** 成员端加入超时（ms）：超过该时长仍未与房主建立任何数据往来即判定加入失败 */
export const JOIN_TIMEOUT_MS = 15000

/** 成员端等待视频桥就绪的时长（ms）：播放器异步创建 video，需轮询注入 */
export const BRIDGE_WAIT_MS = 8000

/** 成员端 seek 宽限期（ms）：seek 后缓冲到位置需要时间，期间禁止重复 seek/rate，避免打断加载造成卡顿 */
export const SEEK_GRACE_MS = 2000

/** 成员端地址漂移重导航冷却（ms）：重新导航后页面/桥需时间落地，冷却内不重复纠正同一目标 */
export const SOURCE_CORRECT_COOLDOWN_MS = 3000

/** 成员端地址漂移连续纠正上限：达到即停止（防站点强制重定向，如登录墙，造成来回死循环） */
export const SOURCE_CORRECT_MAX_ATTEMPTS = 5

/** 房主事件采样间隔（ms）：视频操作事件即时广播的轮询粒度，决定操作同步延迟上限 */
export const EVENT_POLL_MS = 80

/** 房主未就绪确认拍数：连续 N 次心跳未就绪才暂停冻结成员（防 readyState 瞬时波动造成 pause/play 抖动） */
export const NOT_READY_CONFIRMATIONS = 2

/** 房主刚 seek 后的未就绪确认拍数：拖进度加载窗口短，1 拍即冻，缩短成员抢跑 */
export const SEEK_NOT_READY_CONFIRMATIONS = 1

/** 房主 seek 后多少 ms 内的未就绪心跳用更快确认（覆盖 state 心跳间隔） */
export const HOST_SEEK_FAST_WINDOW_MS = 6000

/** 房主播放停滞自愈阈值（ms）：位置无进展且未就绪持续该时长 → 原地重 seek 重建媒体栈请求 */
export const HOST_STALL_RESEEK_MS = 8000

/** 房主等待成员预加载的超时（ms）：超时后不再等，直接继续（成员端自愈路径兜底） */
export const MEMBER_WAIT_TIMEOUT_MS = 30000

/** 预读跟随停滞判定（ms）：成员缺口落在预读跨度内时跟随预读增量转发，
 *  超过该时长无任何新字节则判定预读停滞，改为直拉兜底 */
export const RELAY_FOLLOW_STALL_MS = 15000

/** 成员就绪上报保鲜窗（ms）：超过该时长未刷新的上报视为过期（按未就绪处理） */
export const MEMBER_READY_FRESH_MS = 8000

/** 成员就绪态周期重报间隔（ms）：无变化也重发，维持房主侧新鲜度 */
export const MEMBER_REPORT_INTERVAL_MS = 5000

/** 房主保持暂停的自身动作窗口（ms）：窗口内的 pause/play 事件是保持逻辑自己发起的，不算用户手动操作 */
export const SELF_ACTION_WINDOW_MS = 1500

/**
 * 房主自动动作回声静默窗（ms）：超时续播、看门狗 rekick 等自动 play/seek 产生的事件
 * 回声在窗口内不触发「等待成员预加载」/取消判定——否则超时续播→play 事件→重新 hold→
 * 再超时会与停滞看门狗形成无限震荡，永远到不了真正的用户意图分支
 */
export const AUTO_ACTION_QUIET_MS = 3000
