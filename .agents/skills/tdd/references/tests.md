# 好测试与坏测试

示例语言是 TypeScript；其他语言按同样原则改写。

## 好测试

经过真实接口，测调用方观察到的行为。

```typescript
// 好：验证可观察行为
test("购物车有有效商品时可以结算", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

特征：

- 测用户或调用方在意的行为
- 只使用公共 API
- 内部重构后仍然通过
- 描述「是什么」，不描述「怎么做」
- 一个逻辑断言

## 坏测试

### 与实现细节耦合

```typescript
// 坏：断言内部协作者被调用
test("结算会调用支付服务", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

危险信号：

- mock 内部协作者
- 测试私有方法
- 断言调用次数或调用顺序
- 没改行为，重构后测试却失败
- 测试名描述「怎么做」而不是「是什么」

### 通过旁路验证

```typescript
// 坏：绕过接口直接查库
test("createUser 会写入数据库", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// 好：经过接口验证
test("createUser 之后可以取回该用户", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

### 同义反复

期望值按被测代码的算法重算，测试构造性通过。

```typescript
// 坏：期望值用与实现相同的算法算出
test("calculateTotal 汇总行项目", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// 好：期望值是独立的已知字面量
test("calculateTotal 汇总行项目", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```

期望值的独立来源：已知字面量、worked example、spec 中的验收标准、独立计算的结果。

### 横向切片

先写完一批测试，再写实现。这批测试验证的是**想象中**的行为，测到的是形状而不是行为，而且在对实现还没有理解时就锁定了测试结构。

改为纵向切片：一个测试 → 一份实现 → 重复，每个测试都是一次响应上一轮所学的 tracer bullet。
