/**
 * `GET /api/v1/data-exports/{exportId}/download`（OPS-002；`downloadUrl` 的
 * 落点——契约只定义了字段，指向路径属实现细节，随 RD-015 披露）。
 *
 * 文件字节直接回（非信封）：`Content-Disposition: attachment` + 文件名——
 * 文件名是契约「双呈现」的第一呈现位（含格式版本与日期）。
 */
import { NextResponse } from 'next/server';

import { createApiRouteHandler } from '../../../../../_lib/api-route.ts';
import { createDownloadExportUseCase } from '../../../../../_lib/data-deps.ts';
import { resolveSession } from '../../../../../_lib/session-api.ts';

interface DownloadContext {
  readonly params: Promise<{ readonly exportId: string }>;
}

export const GET = createApiRouteHandler<DownloadContext>(
  async (request, context): Promise<NextResponse> => {
    const session = await resolveSession(request);
    const { exportId } = await context.params;

    const download = createDownloadExportUseCase().execute(session.userId, exportId, new Date());

    return new NextResponse(download.content, {
      status: 200,
      headers: {
        'content-type': download.contentType,
        'content-disposition': `attachment; filename="${download.fileName}"`,
        'cache-control': 'no-store',
      },
    });
  },
  { operation: 'data_export_download' },
);
