---
categories:
- docs
- develop
- stack
- oss
- rs
- rc
- oss
- kubernetes
- clients
description: Learn how to use the INCREX command with go-redis to atomically increment
  a value and set its expiration in a single operation.
linkTitle: Atomic increment with expiry
title: Atomic increment with expiry (INCREX)
weight: 25
---

The [`INCREX`]({{< relref "/commands/increx" >}}) command, introduced in Redis 8.8,
atomically increments a numeric value and sets its expiration in a single round-trip.
`go-redis` exposes two methods for this command:

- **`IncrEXInt`** — for integer increments
- **`IncrEXFloat`** — for floating-point increments

Both methods return a two-element result: the new value of the key after the increment,
and the increment that was actually applied.

## Install and connect

Make sure you have [Redis 8.8 or later]({{< relref "/operate/oss_and_stack/" >}})
and the [`go-redis`]({{< relref "/develop/clients/go" >}}) client installed.

```go
import (
    "context"
    "fmt"

    "github.com/redis/go-redis/v9"
)

func main() {
    rdb := redis.NewClient(&redis.Options{
        Addr: "localhost:6379",
    })
    defer rdb.Close()

    ctx := context.Background()
```

## Integer increment

Use `IncrEXInt` to increment a key by an integer amount. If the key doesn't exist,
it is initialized to `0` before the increment.

```go
// Increment by 1 (default), no expiration set
result, err := rdb.IncrEXInt(ctx, "counter", &redis.IncrEXIntArgs{}).Result()
if err != nil {
    panic(err)
}
fmt.Println(result.Value)     // new value
fmt.Println(result.AppliedIncrement) // increment actually applied
```

Increment by a specific amount and set a 60-second expiration:

```go
result, err := rdb.IncrEXInt(ctx, "counter", &redis.IncrEXIntArgs{
    Increment: 5,
    Expiration: 60 * time.Second,
}).Result()
```

## Float increment

Use `IncrEXFloat` when your counter holds a floating-point value:

```go
result, err := rdb.IncrEXFloat(ctx, "score", &redis.IncrEXFloatArgs{
    Increment:  0.5,
    Expiration: 60 * time.Second,
}).Result()
fmt.Println(result.Value)     // e.g. 1.5
fmt.Println(result.AppliedIncrement) // e.g. 0.5
```

## Bounds and SATURATE

Use `LBound` and `UBound` to prevent the counter from going out of range.
By default, when the result would exceed a bound, the operation is skipped and
`AppliedIncrement` is `0`. Set `Saturate: true` to cap the result at the bound
instead of skipping.

```go
// Cap at 100 — skip the increment if it would exceed the upper bound
result, err := rdb.IncrEXInt(ctx, "counter", &redis.IncrEXIntArgs{
    Increment: 10,
    UBound:    100,
}).Result()
if result.AppliedIncrement == 0 {
    fmt.Println("rate limit reached")
}

// Cap at 100 — saturate to the bound instead of skipping
result, err = rdb.IncrEXInt(ctx, "counter", &redis.IncrEXIntArgs{
    Increment: 10,
    UBound:    100,
    Saturate:  true,
}).Result()
```

## ENX: set expiration only on new keys

The `ENX` option sets the TTL only if the key currently has no expiration. This
is useful for sliding-window rate limiters: the window starts when the key is
first created, and subsequent increments extend the count without resetting the timer.

```go
result, err := rdb.IncrEXInt(ctx, "ratelimit:user:42", &redis.IncrEXIntArgs{
    Increment:  1,
    UBound:     100,
    Expiration: 60 * time.Second,
    ENX:        true,
}).Result()

if result.AppliedIncrement == 0 {
    // Counter was already at the cap — reject the request
    fmt.Println("rate limit exceeded")
}
```

The first call creates the key with a 60-second TTL. Subsequent calls within
that window increment the counter without touching the TTL. Once the window
expires, the key is deleted and the next call starts a new window.

## Return values

Both `IncrEXInt` and `IncrEXFloat` return a struct with two fields:

| Field | Description |
|---|---|
| `Value` | The value of the key after the increment |
| `AppliedIncrement` | The increment actually applied. `0` when the operation was skipped because the result would have exceeded a bound |

If `Saturate` is set, `AppliedIncrement` reflects the saturated delta rather than
the requested increment.

## See also

- [`INCREX` command reference]({{< relref "/commands/increx" >}})
- [Strings data type]({{< relref "/develop/data-types/strings" >}})
- [`INCR`]({{< relref "/commands/incr" >}}) | [`INCRBY`]({{< relref "/commands/incrby" >}}) | [`INCRBYFLOAT`]({{< relref "/commands/incrbyfloat" >}})
