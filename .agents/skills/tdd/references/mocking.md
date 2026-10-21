# 何时 mock

只在**系统边界**上 mock：

- 外部 API（支付、邮件等）
- 数据库（有时；优先用测试库）
- 时间与随机数
- 文件系统（有时）

不要 mock：

- 自己写的类或模块
- 内部协作者
- 任何自己控制的东西

## 为可 mock 性设计接口

边界接口本身要容易替换。

### 依赖注入

把外部依赖传进去，不要在内部创建。

```typescript
// 容易 mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// 难以 mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

### 用 SDK 风格的接口，不用通用 fetcher

每个外部操作一个独立函数，而不是一个带条件分支的通用函数。

```typescript
// 好：每个函数可独立 mock
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch("/orders", { method: "POST", body: data }),
};

// 坏：mock 内部还要写条件逻辑
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

SDK 风格的好处：

- 每个 mock 只返回一种确定的形状
- 测试准备里没有条件逻辑
- 一眼能看出测试覆盖了哪些端点
- 每个端点各自有类型
