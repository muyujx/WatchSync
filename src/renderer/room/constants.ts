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

/** 房主等待成员预加载的超时（ms）：超时后不再等，直接继续（成员靠校准循环追平） */
export const MEMBER_WAIT_TIMEOUT_MS = 30000

/** 预读跟随停滞判定（ms）：成员缺口落在预读跨度内时跟随预读增量转发，
 *  超过该时长无任何新字节则判定预读停滞，改为直拉兜底 */
export const RELAY_FOLLOW_STALL_MS = 15000

/** 成员「加载完成」提前量（s）：元素缓冲提前量或本地副本落盘字节折算的内容秒数达到该值
 *  （或整份落盘/缓冲到片尾）才算就绪，房主据此放行「等待成员预加载」。
 *  readyState>=2 只代表能解当前帧——刚开副本就误报就绪，房主直接续播会让成员几秒后
 *  数据耗尽卡住；且暂停期 Chromium 回收 media-server 播放面的 buffered 区间（恒空） */
export const MEMBER_READY_AHEAD_S = 10

/** 成员就绪应答保鲜窗（ms）：超过该时长未刷新的应答视为过期（按未就绪处理） */
export const MEMBER_READY_FRESH_MS = 8000

/** 房主保持暂停的自身动作窗口（ms）：窗口内的 pause/play 事件是保持逻辑自己发起的，不算用户手动操作 */
export const SELF_ACTION_WINDOW_MS = 1500

/**
 * 房主自动动作回声静默窗（ms）：超时续播等自动 play 产生的事件回声在窗口内
 * 不触发「等待成员预加载」/取消判定——否则超时续播→play 事件→重新 hold→再超时
 * 会无限震荡，永远到不了真正的用户意图分支
 */
export const AUTO_ACTION_QUIET_MS = 3000
