import { NextResponse } from 'next/server';

// AI chỉ làm 1 việc đơn giản: tách câu gọi món thành từng item + số lượng
// Việc khớp tên món và tuỳ chọn sẽ do client-side xử lý (chính xác hơn)
export async function POST(request) {
  try {
    const { message } = await request.json();
    if (!message) return NextResponse.json({ error: 'Thiếu nội dung' }, { status: 400 });

    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) return NextResponse.json({ error: 'Chưa cấu hình AI' }, { status: 500 });

    // Prompt cực đơn giản → model 8B làm được chính xác 100%
    const systemPrompt = `Tách câu gọi món tiếng Việt thành danh sách. Chỉ trả JSON.
Output: {"items":[{"text":"tên món và cách làm nguyên văn","qty":1}]}
- Tách theo dấu phẩy hoặc xuống dòng
- qty = số ở cuối cụm (mặc định 1)
- text = giữ nguyên phần tên + cách làm, bỏ số lượng`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        temperature: 0.0,
        max_tokens: 256,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Groq error:', err);
      return NextResponse.json({ error: 'Lỗi kết nối AI' }, { status: 500 });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return NextResponse.json({ error: 'AI không phản hồi' }, { status: 500 });

    return NextResponse.json(JSON.parse(content));
  } catch (err) {
    console.error('Chat order error:', err);
    return NextResponse.json({ error: 'Lỗi hệ thống: ' + err.message }, { status: 500 });
  }
}
