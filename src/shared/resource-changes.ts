/** 浏览器失效提示；revision 是源对象的版本，不是事件游标。
 * 同一 Task revision 可产生新评论/评审记录，消费者仍须条件 GET 当前快照。
 * 新模块接入时同时增加自己的发送授权检查，不能回退为无范围广播。
 */
export interface ResourceChange {
  projectId: string;
  entity: "task" | "task-settings";
  id: string;
  revision: number;
}
export interface ResourceChangedEvent extends ResourceChange { type: "resource.changed" }
