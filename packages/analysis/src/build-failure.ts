/** Human-readable one-line summary for a raw Build / workflow failure string. */
export function summarizeBuildFailure(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) return "出现未知错误，请查看完整信息。";
  if (/^Build (未完成|已取消|失败)/u.test(text)) {
    return text
      .replace(/^Build 未完成/u, "生成未完成")
      .replace(/^Build 已取消/u, "生成已取消")
      .replace(/^Build 失败/u, "生成失败");
  }
  const sceneMatch = /component::(scene-\d+)/u.exec(text);
  const sceneHint = sceneMatch === null ? "" : `（第 ${sceneMatch[1].replace("scene-", "")} 段画面）`;
  if (/429|rate limit|RateLimitReached|call rate limit/iu.test(text)) {
    return `生成请求过于频繁${sceneHint}，请等待约 1 分钟后重试。`;
  }
  if (/HTTP 500|unexpected EOF|read_response_body_failed/iu.test(text)) {
    return `生成服务暂时不可用${sceneHint}，请稍后重试。`;
  }
  if (/\/videos returned HTTP 404|path":"\/api\/minimax\/videos"/iu.test(text)) {
    return "口播视频服务连接失败，请稍后重试或联系管理员。";
  }
  if (/\/files\b.*404|\/api\/minimax\/files/iu.test(text)) {
    return `素材上传服务不可用${sceneHint}，请稍后重试或联系管理员。`;
  }
  if (/HTTP 404|not found for API|NOT_FOUND/iu.test(text)) {
    return `画面生成模型不可用${sceneHint}，请检查服务配置。`;
  }
  if (/401|403|invalid.*api.*key|authentication/iu.test(text)) {
    return `服务密钥无效或未配置${sceneHint}，请检查项目环境配置。`;
  }
  if (/RUNTIME_CREDENTIAL_MISSING|未配置 OPENAI_API_KEY|credential.*missing/iu.test(text)) {
    return `服务密钥未加载${sceneHint}，请配置环境后重新打开页面。`;
  }
  if (/未返回 build id/iu.test(text)) {
    return `视频生成未能启动${sceneHint}，请稍后重试。`;
  }
  if (/ECONNREFUSED|fetch failed|无法连接/iu.test(text)) {
    return `无法连接生成服务${sceneHint}，请确认服务已启动后重试。`;
  }
  if (/cannot resolve product-reference/iu.test(text)) {
    return "参考图无法识别，请重新上传参考图后再次一键复刻。";
  }
  if (/captureScreenshot|Unable to capture screenshot|Session closed.*page has been closed/iu.test(text)) {
    return "本地画面渲染失败，请关闭占用内存的程序后重试。";
  }
  if (/Video source could not be decoded/iu.test(text)) {
    return "视频素材损坏或下载不完整，请重新生成。";
  }
  if (/hyperframes\.local failed render-visual|request-visual-render ended without a stored result/iu.test(text)) {
    return "成片合成时画面渲染失败，请重试生成。";
  }
  if (/JavaScript heap out of memory|heap out of memory/iu.test(text)) {
    return "本地内存不足，请关闭其他程序后重试。";
  }
  if (/场景 prompt 生成不完整/u.test(text)) {
    return "画面描述生成不完整，请再次点击一键复刻。";
  }
  if (sceneMatch !== null) return `第 ${sceneMatch[1].replace("scene-", "")} 段画面生成失败，请查看下方完整信息。`;
  return "视频生成失败，请查看下方完整信息。";
}

export function partialBuildFailureDetail(): string {
  return "生成未完成：已返回部分片段，但最终成片尚未合成。";
}

export function cancelledBuildFailureDetail(): string {
  return "生成已取消，未产出最终成片。";
}
