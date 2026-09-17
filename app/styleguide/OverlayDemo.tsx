'use client';

import { useState } from 'react';

import { Button, ConfirmDialog, Modal } from '@/shared/ui/components';

import styles from './styleguide.module.css';

/**
 * 浮层组件的客户端包装（UI-002 批次 3a）。
 *
 * 浮层是受控交互组件，必须落在客户端边界内；styleguide 页面本身仍是服务端
 * 组件（批次 1 起刻意如此，用来证明纯展示组件能在 RSC 里直接用）。
 *
 * ## 演示里特意包含了「从弹窗里再开一个确认」这条路径
 *
 * 这不是为了凑场景：嵌套浮层是 ESC 处理最容易出错的地方——如果每层都无条件
 * 响应 ESC，一次按键会把两层一起关掉。这里让 Playwright 能真的按一次 ESC、
 * 然后断言外层的 Modal 还在。
 */
export function OverlayDemo() {
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [nestedConfirmOpen, setNestedConfirmOpen] = useState(false);

  function closeConfirm(): void {
    setConfirmOpen(false);
    setNestedConfirmOpen(false);
  }

  return (
    <div className={styles.row}>
      <Button
        variant="secondary"
        onClick={() => {
          setModalOpen(true);
        }}
        data-variant="open-modal"
      >
        打开编辑弹窗
      </Button>

      <Button
        variant="danger"
        onClick={() => {
          setConfirmOpen(true);
        }}
        data-variant="open-confirm"
      >
        删除（危险确认）
      </Button>

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
        }}
        title="编辑任务"
        footer={
          <>
            <Button
              onClick={() => {
                setModalOpen(false);
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setModalOpen(false);
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <p>弹窗只承载单一动作，不塞完整流程（§4.5）。</p>
        <p>
          <Button
            variant="danger"
            onClick={() => {
              setNestedConfirmOpen(true);
            }}
            data-variant="open-nested-confirm"
          >
            从弹窗里再开确认
          </Button>
        </p>
      </Modal>

      {/* 内层与外层共用同一个 ConfirmDialog 实例：Portal 会把两者都挂到 body 下
          成为兄弟节点，与真实使用一致（嵌套关系体现在"谁先打开"而不是 DOM 层级上）。 */}
      <ConfirmDialog
        open={confirmOpen || nestedConfirmOpen}
        onCancel={closeConfirm}
        onConfirm={closeConfirm}
        destructive
        title="删除这个任务？"
        description="删除后无法恢复，关联的目标进度会同步回退。"
        confirmLabel="删除"
      />
    </div>
  );
}
