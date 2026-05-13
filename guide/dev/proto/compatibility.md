# Protobuf 兼容性规则

> Deepsight 的 proto 是 Probe、Server、未来 MCP 层之间的稳定契约。字段一旦发布，就不能像普通内部结构体一样随意改名、改编号或改变语义。

---

## 一、基本规则

必须遵守：

1. **不要复用字段编号**：删除字段后，编号应保留或标记 reserved。
2. **不要改变已有字段语义**：例如 `pid = 2` 不能改成 `tgid`。
3. **新增字段使用新编号**：优先追加，不要插入式重排。
4. **不要重命名 package 和 go_package**，除非接受全量破坏性迁移。
5. **oneof 新增分支必须同步实现 Server dispatcher**。
6. **模块 payload 不放总线字段**，总线字段统一在 wrapper 或 batch。

---

## 二、字段编号

错误示例：

```protobuf
message ProcessEvent {
  string event_type = 1;
  uint32 pid = 2;
  string comm = 3;
}

// 错误：把 2 从 pid 改成 uid
message ProcessEvent {
  string event_type = 1;
  uint32 uid = 2;
  string comm = 3;
}
```

正确做法：

```protobuf
message ProcessEvent {
  string event_type = 1;
  uint32 pid = 2;
  string comm = 3;
  uint32 uid = 4;
}
```

如果字段确实删除：

```protobuf
message ProcessEvent {
  reserved 4;
  reserved "old_field";

  string event_type = 1;
  uint32 pid = 2;
  string comm = 3;
}
```

---

## 三、oneof 演进

允许新增 oneof 分支：

```protobuf
oneof payload {
  NetworkEvent network = 4;
  StorageEvent storage = 5;
  ProcessEvent process = 6;
  MemoryEvent memory = 7;
}
```

但必须同步：

- import 新模块 proto
- Probe transformer 构造新 payload
- Server dispatcher 增加新 case
- 测试覆盖新 payload 分发
- 文档更新模块接入说明

禁止：

- 改变已有 oneof 字段编号。
- 把已有分支换成不同 message 类型。
- 用 `string json_payload` 绕过强类型分发。

---

## 四、枚举演进

枚举必须保留 `*_UNSPECIFIED = 0`。

允许追加：

```protobuf
enum Severity {
  SEVERITY_UNSPECIFIED = 0;
  SEVERITY_INFO = 1;
  SEVERITY_WARN = 2;
  SEVERITY_ERROR = 3;
  SEVERITY_CRITICAL = 4;
  SEVERITY_FATAL = 5;
}
```

禁止：

- 改变已有枚举数字。
- 删除枚举后复用数字。
- 让 0 表示某个具体业务状态。

---

## 五、Metric/Event 兼容性

如果一个数据最初设计成 Metric，后续发现需要作为 Event，不要直接改变原字段语义。

推荐做法：

- 保留原 Metric 字段作为趋势指标。
- 新增对应 Event payload 表达具体证据。

例子：

```text
NETWORK_METRIC_KIND_PACKET_DROPS 继续作为 NetworkMetric
NETWORK_EVENT_KIND_PACKET_DROP 新增为 NetworkEvent 证据
```

这样 Server 的滑动窗口和事件队列都能稳定演进。

---

## 六、版本策略

当前包路径为：

```protobuf
package deepsight.v1;
```

兼容性变更继续放在 `v1`：

- 新增字段
- 新增 message
- 新增 oneof 分支
- 新增枚举值

破坏性变更必须进入新版本，例如 `proto/v2`：

- 改变字段编号或含义
- 改变 RPC 流模式
- 删除关键字段
- 重构 session/dictionary 语义

Hello 阶段应尽量避免引入 `v2`，优先通过追加字段演进。

### 6.1 当前分支 TaskChannel lockstep 例外

默认规则仍然成立：已稳定发布契约中改变 RPC 流模式通常必须进入新版本，例如
`proto/v2`。

当前分支接受一次例外：将
`TaskChannel(stream TaskResponse) returns (stream TaskRequest)` 替换为显式
`TaskChannel(stream TaskChannelUpstream) returns (stream TaskChannelDownstream)`。

例外条件：

- 旧 TaskChannel stream shape 尚未作为已接受的稳定发布契约交付。
- Bob-owned Server 端 TaskChannel 仍以未实现控制面处理，未形成稳定可用 Server 行为。
- 变更必须在同一分支、同一 release 内同步 `proto/`、`api/`、Probe exporter、Server skeleton、E2E testutil 和 wire-facing docs。
- 不新增 `V2` RPC 名称，不保留旧 stream shape，不识别旧 payload，不做双协议 fallback。
- 不支持混合版本 Probe/Server；部署文档必须要求 Probe 和 Server 使用同一 release。

这不是旧协议兼容策略，而是当前分支内的一次 lockstep breaking replacement。

---

## 七、生成与提交

修改 proto 后必须执行：

```bash
make proto
```

并检查生成文件：

```text
api/common/*.pb.go
api/modules/*.pb.go
api/v1/*.pb.go
```

提交时 proto 源文件和生成后的 Go API 必须同步。否则其他开发者在未安装完整 protoc 工具链时可能无法编译。

推荐验证：

```bash
GOCACHE=/tmp/deepsight-gocache go test ./...
GOCACHE=/tmp/deepsight-gocache make build
```
