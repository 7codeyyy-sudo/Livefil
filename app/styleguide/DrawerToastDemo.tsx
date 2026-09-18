'use client';

import { useState } from 'react';

import { Button, Drawer, Input, Textarea, useToast } from '@/shared/ui/components';

import styles from './styleguide.module.css';

/**
 * Drawer 的客户端包装（UI-002 批次 3b）。
 *
 * ## 正文为什么刻意很长
 *
 * 三段结构里有两处是"只有内容超过一屏才能验证"的：Header 不随内容滚、
 * Footer 钉在底部。正文短的时候这两件事看不出来（它们和"被动地待在那里"
 * 长得一样），所以这里放了一段专门用来撑高的填充块。
 *
 * ## 为什么抽屉里要放一个「发提示」按钮
 *
 * 用来验证 `--z-toast` 真的高于 `--z-overlay`：**提示条浮在已打开的抽屉之上**。
 * 这个关系只在两者同时可见时才成立，页面上的分区顺序帮不上忙
 * （提示条是 `position: fixed`，本来就不受分区约束）。
 */
export function DrawerDemo() {
  const [open, setOpen] = useState(false);
  const toast = useToast();

  return (
    <div className={styles.row}>
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
        data-variant="open-drawer"
      >
        打开详情抽屉
      </Button>

      <Drawer
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title="编辑任务"
        footer={
          <>
            <Button
              onClick={() => {
                setOpen(false);
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setOpen(false);
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <div className={styles.fieldGrid}>
          <Input label="任务名称" defaultValue="整理本周开销" />
          <Input label="预计时长" hint="单位分钟" defaultValue="30" />
          <Textarea label="备注" defaultValue="把发票和账单一起归档。" />
        </div>

        <p className={styles.row}>
          <Button
            variant="secondary"
            onClick={() => {
              toast.success('已保存');
            }}
            data-variant="toast-inside-drawer"
          >
            发一条提示（验证提示浮在抽屉之上）
          </Button>
        </p>

        {/* 撑高正文用，不表达任何内容。高度取一个远大于常见视口的值，
            让「Body 是唯一滚动区」在任何桌面视口下都可观察。 */}
        <div className={styles.drawerFiller} aria-hidden="true" />
      </Drawer>
    </div>
  );
}

/**
 * Toast 的客户端包装（UI-002 批次 3b）。
 *
 * 四个入口对应四种时长口径：普通 5s、成功 5s、错误**常驻**、带操作 8s。
 * 「连发 4 条」用来验证 3 条上限与淘汰顺序（淘汰最老的**可自动关闭**条）。
 */
export function ToastDemo() {
  const toast = useToast();

  return (
    <div className={styles.row}>
      <Button
        variant="secondary"
        onClick={() => {
          toast.show('已保存');
        }}
        data-variant="toast-plain"
      >
        普通（5 秒）
      </Button>

      <Button
        variant="secondary"
        onClick={() => {
          toast.success('已归档');
        }}
        data-variant="toast-success"
      >
        成功（5 秒）
      </Button>

      <Button
        variant="danger"
        onClick={() => {
          toast.error('同步失败，请重试');
        }}
        data-variant="toast-error"
      >
        错误（常驻）
      </Button>

      <Button
        variant="secondary"
        onClick={() => {
          toast.show('任务已归档', {
            action: {
              label: '撤销',
              // 撤销逻辑属于业务（§4.5：随真实消费者接线），这里只证明槽位可用。
              onClick: () => undefined,
            },
          });
        }}
        data-variant="toast-with-action"
      >
        带撤销（8 秒）
      </Button>

      <Button
        variant="secondary"
        onClick={() => {
          // 连发 4 条：4 次函数式 setState 会按顺序落到同一个队列上，
          // 所以结果必然是「第 1 条被淘汰、留下后 3 条」。
          toast.show('第一条');
          toast.show('第二条');
          toast.show('第三条');
          toast.show('第四条');
        }}
        data-variant="toast-overflow"
      >
        连发 4 条（验证上限）
      </Button>
    </div>
  );
}
