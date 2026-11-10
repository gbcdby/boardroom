# 独立计划与证据包

当多状态、多个属性或接收方要求机器检查覆盖时读取。小改可继续用短记录；本格式只处理有图片基准的证据，不替无图动效制造 reference 或用图片证明连续过程。

## 目录

- 选择与冻结计划
- 计划和结果格式
- 候选与捕获来源
- 命令、退出码与历史兼容

## 选择与冻结计划

先按本次范围建立 `visual-plan.json`，记录确认来源、图像身份、适用项及目标，并在实现／修正或评判前固定 SHA256；结果写入独立 `visual-review.json`。已有有效计划直接沿用。变更计划须保留来源、原因与替代关系，不能看结果后删项或重算 hash 消除失败；脚本不能证明计划制定时间或变更已经授权。

完整计划按元素评估 `layout/background/color/border/shape/typography/icon/artwork` 八类属性，适用项在 `attributes`，其余在 `not_applicable` 写本次理由；状态、可访问性、动效等需要时可加属性。每个适用元素／属性至少有检查项，每个声明验收的 capture 至少被一项检查覆盖；每个 check 明确自己的 capture 范围，不要求所有检查覆盖所有设备。

## 计划和结果格式

以下是结构示例，路径、哈希、状态、目标和不适用理由必须换成本次事实。这里只列一个 capture 便于阅读；实际多状态按同结构扩展。

`visual-plan.json`：

```json
{
  "schema_version": 1,
  "basis": "用户确认消息／页面合同及本次范围",
  "captures": [{
    "id": "default", "device": "browser 800x600@1x", "font_scale": 1,
    "state": "default", "reference": {"path": "approved.png", "sha256": "<原图SHA256>"}
  }],
  "elements": [{
    "id": "primary-action", "attributes": ["shape", "border"],
    "not_applicable": {
      "layout": "本次布局不变，关联溢出在shape检查中核对",
      "background": "本次填色及底纹不变", "color": "边线颜色列入border",
      "typography": "文字不变，关联裁切在shape检查中核对",
      "icon": "此控件无图标", "artwork": "此区域无插画"
    }
  }],
  "checks": [
    {"id": "outline", "element": "primary-action", "attribute": "shape",
     "target": "按确认图核对轮廓、比例和裁切", "basis": "确认图采用区域", "captures": ["default"]},
    {"id": "border", "element": "primary-action", "attribute": "border",
     "target": "按组件合同核对边线粗细、颜色和衔接", "basis": "组件合同版本", "captures": ["default"]}
  ]
}
```

`visual-review.json`：

```json
{
  "required_regions": ["primary-action"],
  "captures": [{
    "id": "default", "version": "<候选身份>",
    "device": "browser 800x600@1x", "font_scale": 1, "state": "default",
    "reference": {"path": "approved.png", "sha256": "<原图SHA256>"},
    "actual": {"path": "raw.png", "sha256": "<原始运行图SHA256>"},
    "side_by_side": {"path": "round-01/side-by-side.png", "sha256": "<文件SHA256>"},
    "overlay": {"path": "round-01/overlay.png", "sha256": "<文件SHA256>"}
  }],
  "regions": [{"capture": "default", "name": "primary-action", "status": "pending"}],
  "checks": [
    {"capture": "default", "check_id": "outline", "status": "pending"},
    {"capture": "default", "check_id": "border", "status": "pending"}
  ]
}
```

- `captures` 的 ID、候选版本和设备须非空；`font_scale` 须是正有限数。媒体路径相对结果 manifest，或用可访问绝对路径，SHA256 绑定字节内容。计划比较采用原图的 SHA256，不靠文件名判断同一图。
- 结果 capture 集合须等于计划集合；`device/font_scale` 必须一致，计划声明的 `state/theme/language/lifecycle` 也须一致。纯展示帧不要混入声明验收的 captures。
- `required_regions` 是每个 capture 都要记录的区域概览；各 capture 要有且仅有一条对应 region。区域随状态差异很大时拆成合适的证据组，或沿用现有人工记录，不填写无关的通过项。
- `checks` 对应计划中每个 `(capture, check_id)`，不能漏、重复或自加结果。计划属性覆盖与区域概览同时检查；一条“区域正常”不能代替属性结论。
- 实际打开原图、运行图、并排图和所需叠图后，填写 `observation`，再将 region／check 标为 `pass/fail/exception`；尚未阅图保留 `pending`。check 的非 pending 结果还须有 `reviewed_media`，至少包含 `reference/actual/side_by_side`，可含 `overlay`。
- `exception` 必须有非空 `acceptance_source`，写明谁在何处接受了哪项偏差。字段只声明已阅或已接受，脚本不会代替人或代理作决定。

## 候选与捕获来源

`--expect-version` 支持非空候选标识，例如提交、构建身份或可重建快照；所有 capture 的 `version` 必须对应它。该字段本身不能证明设备加载了该版本，仍须保留启动记录、页面标识、时间与复现动作。作者检查继续标为 `self_check`，工具中的历史名称 `reviewer_reported_pass` 不证明独立性。

原有 Git 捕获记录继续兼容，按实际需要使用：

- `capture_record: {path, sha256}` 指向本次捕获 JSON，路径相对结果 manifest。记录须含 `status: "captured"`、原捕获 `head`（40 位提交 SHA）、`dirty_sources`（布尔）、非空 `source_files` 及 `actual.sha256`；其源码列表和截图哈希须与 capture 相同。
- 无 `source_binding` 时，记录的 head 必须等于期待候选，且 `dirty_sources` 为 false。
- 脏捕获或跨提交复用时，可用 `source_binding: {commit, files}` 将捕获源码／素材关联到最终提交；`commit` 等于期待候选，各 capture 的 `source_files` 等于 `files`。每项文件为 `{path, sha256}`，路径相对 `--repo` 指定 Git checkout，脚本用 `git show` 核对该提交的内容。只允许安全相对路径，继续拒绝 `.env*` 路径；不采集凭据。
- 保留 capture record 中的原 head，不把历史捕获改写成新拍摄。文件列表须覆盖实际影响画面的源码／素材；工具只检查列出的文件，不能证明列表完整，也不能证明运行时确实加载它们。有关文件变更就重拍受影响状态。

无 Git 项目使用自己的候选／构建与捕获记录，不制造 Git 字段；新工具不会要求历史记录补写不存在的来源。缺少必要来源依据时保留待验证，不把兼容读取当作当前完整验收。

## 命令、退出码与历史兼容

```bash
python3 <skill-root>/scripts/visual_review_bundle.py <visual-review.json> \
  --expect-version <candidate-id> --plan <visual-plan.json> --expect-plan-sha <frozen-sha256>
python3 <skill-root>/scripts/visual_review_bundle.py <visual-review.json> \
  --expect-version <candidate-id> --plan <visual-plan.json> --expect-plan-sha <frozen-sha256> --finalize
```

只有可选 Git 内容关联需要 `--repo <checkout>`。使用实际可用的 Python 与 Pillow。工具检查文件哈希、图像可解码、身份与声明覆盖；不会判断截图是否来自真实运行、是否读过图、视觉质量或例外授权。

| 调用／结果 | 解释 |
|---|---|
| 普通模式退出 0 | 结构和证据声明有效，可仍有 pending／fail |
| 错误退出 1 | 输入、媒体、身份、计划哈希或覆盖有误 |
| `--finalize` 退出 2 | 结构有效，但声明结果仍有 fail／pending |
| `--finalize` 退出 0 | 有完整计划且声明结果无 fail／pending；`exception` 保持 `partial` |

`acceptance_complete` 是兼容字段，表示所声明计划审阅的完整性，不是自动视觉 PASS。`judgment_origin: reviewer_declared` 标明结论来自填表者；`validation_scope` 有计划为 `planned_attributes`，无计划为 `declared_regions`。`visual_result` 保留 `fail/pending/partial/reviewer_reported_pass`，都只转述记录。

无计划的旧 manifest 可省略 `--plan/--expect-plan-sha`，继续检查媒体、版本与声明区域；返回 `coverage: null`、`acceptance_complete: false`。它可用于历史复核或展示，不升级为新完整计划验收；`--finalize` 仍要求计划与冻结 SHA，缺失退出 1。有效旧记录无需为新字段重写，损坏图像和空的必要身份不属于有效记录。
