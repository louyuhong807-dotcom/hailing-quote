const DEFAULT_PROMPT = `你是海陵岛资深民宿销售客服，擅长把客户需求转成自然、真诚、可直接微信发送的中文回复。

硬性规则：
1. 只能推荐输入 JSON 中 rooms 数组里的房源，不得新增、替换或猜测房源。
2. 房型、房间数、床数、日期、价格、价格类型、片区、配套和链接必须逐字忠于输入数据。
3. exactPrice 有数值时，只能使用该入住日期的 exactPrice；不得改用最低价或价格区间。
4. exactPrice 为 null 时，必须明确说“该日期需人工核价”，只能把 priceRange 作为参考区间，不能说成当天价格。
5. 不得承诺房态、优惠、赠品、距离、景观或服务。cautions 中的信息必须自然提醒客户确认。
6. 回复要有真人客服感，避免夸张、模板腔、机械罗列和虚假紧迫感。
7. 开头简短复述客户需求，随后推荐 1-3 套。每套包含房型、精确日期价格或核价说明、匹配理由、房型链接。
8. 结尾引导客户选择偏好，再核实时段房态和最终到手价。
9. 只输出可直接发给客户的正文，不解释规则，不使用 Markdown 表格。`;

function jsonResponse(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return jsonResponse(res, 405, { error: "Method not allowed" });
  if (!process.env.OPENAI_API_KEY) return jsonResponse(res, 503, { error: "OPENAI_API_KEY is not configured" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const rooms = Array.isArray(body.rooms) ? body.rooms.slice(0, 3) : [];
  if (!String(body.customerNeed || "").trim() || !rooms.length) {
    return jsonResponse(res, 400, { error: "Missing customer need or matched rooms" });
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      store: false,
      instructions: process.env.SALES_SYSTEM_PROMPT || DEFAULT_PROMPT,
      input: JSON.stringify({
        customerNeed: body.customerNeed,
        parsedNeed: body.parsedNeed || {},
        matchedRooms: rooms,
        fallbackReply: body.fallbackReply || "",
      }),
    }),
  });

  const data = await response.json();
  if (!response.ok) return jsonResponse(res, response.status, { error: data.error?.message || "OpenAI request failed" });
  const reply = data.output_text || (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (!reply) return jsonResponse(res, 502, { error: "Empty model response" });
  return jsonResponse(res, 200, { reply });
}
