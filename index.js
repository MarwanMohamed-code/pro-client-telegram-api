// =======================================================
// 1. إعدادات Telegram API - سيتم جلبها من البيئة
// يجب إدخال هذه المتغيرات في إعدادات Deno Deploy (BOT_TOKEN, CHAT_ID)
// =======================================================
const BOT_TOKEN = Deno.env.get("BOT_TOKEN") || "BOT_TOKEN_REQUIRED";
const CHAT_ID = Deno.env.get("CHAT_ID") || "CHAT_ID_REQUIRED";
const TELEGRAM_UPLOAD_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
// =======================================================

// Headers for CORS (السماح بالوصول من أي موقع)
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// =======================================================
// دالة الرفع الرئيسية: تُرسل الملف إلى Telegram وتُرجع file_id ورابط البث
// المسار: /upload_file
// =======================================================
async function handleUpload(req) {
    if (BOT_TOKEN === "BOT_TOKEN_REQUIRED") {
        return new Response(
            JSON.stringify({ success: false, message: "Server Error: BOT_TOKEN is not configured." }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

    try {
        const formData = await req.formData();
        const file = formData.get('file');

        if (!file || typeof file === 'string') {
            return new Response(
                JSON.stringify({ success: false, message: "No file part in the request (Field name must be 'file')." }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        const telegramFormData = new FormData();
        telegramFormData.append('chat_id', CHAT_ID);
        telegramFormData.append('caption', `Uploaded via Web App: ${file.name}`);
        telegramFormData.append('document', file, file.name); 

        const telegramResponse = await fetch(TELEGRAM_UPLOAD_URL, {
            method: 'POST',
            body: telegramFormData,
        });

        if (!telegramResponse.ok) {
            const errorText = await telegramResponse.text();
            throw new Error(`Telegram API Upload Failed: ${telegramResponse.status} - ${errorText}`);
        }

        const data = await telegramResponse.json();

        if (data.ok) {
            const documentInfo = data.result.document || data.result.photo.pop();
            const fileId = documentInfo.file_id;
            const fileName = file.name;
            
            // نستخدم رابط الدومين الحالي لبناء رابط الـ streaming الذي سيتم حفظه في Firestore
            const baseDomain = new URL(req.url).origin;

            return new Response(
                JSON.stringify({
                    success: true,
                    file_id: fileId,
                    filename: fileName,
                    // رابط العرض يستخدم نقطة نهاية /stream_file الجديدة
                    url: `${baseDomain}/stream_file?file_id=${fileId}&filename=${fileName}`,
                    message: "File uploaded successfully. Streaming URL generated."
                }),
                { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        } else {
            throw new Error(`Telegram API Error: ${data.description || 'Unknown error'}`);
        }

    } catch (e) {
        console.error(e);
        return new Response(
            JSON.stringify({ success: false, message: e.message || "An unexpected server error occurred." }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
}

// =======================================================
// دالة عرض الملفات: تقوم بتمرير (Proxy) الملف للعرض المباشر (Streaming)
// المسار: /stream_file
// =======================================================
async function handleStream(req) {
    const url = new URL(req.url);
    const fileId = url.searchParams.get('file_id');
    const fileName = url.searchParams.get('filename') || 'file';

    if (!fileId) {
        return new Response(JSON.stringify({ success: false, message: 'Missing file_id parameter.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    try {
        // 1. طلب مسار الملف من Telegram باستخدام file_id
        const getFileUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
        const fileResponse = await fetch(getFileUrl);
        const fileData = await fileResponse.json();

        if (!fileData.ok) {
            throw new Error(`Telegram getFile API Error: ${fileData.description || 'Unknown error'}`);
        }

        const filePath = fileData.result.file_path;
        const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

        // 2. طلب الملف الفعلي من Telegram
        const fileFetchResponse = await fetch(downloadUrl);

        if (!fileFetchResponse.ok) {
            throw new Error(`Failed to fetch file from Telegram: ${fileFetchResponse.statusText}`);
        }
        
        // 3. تمرير (Proxy) الملف إلى المتصفح مع الرؤوس المناسبة
        // يتم نسخ الرؤوس لضمان العرض المباشر (خاصة للفيديوهات)
        const responseHeaders = new Headers(fileFetchResponse.headers);
        responseHeaders.set('Content-Disposition', `inline; filename="${fileName}"`); 
        responseHeaders.set('Access-Control-Allow-Origin', '*'); 
        responseHeaders.set('Cache-Control', 'public, max-age=31536000'); // تفعيل التخزين المؤقت

        return new Response(fileFetchResponse.body, { 
            status: 200, 
            headers: responseHeaders 
        });

    } catch (e) {
        console.error("Stream Error:", e.message);
        return new Response(JSON.stringify({ success: false, message: e.message || "An unexpected streaming error occurred." }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

// =======================================================
// نقطة دخول السيرفر الرئيسية: التوجيه (Routing)
// =======================================================
Deno.serve(async (req) => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // التعامل مع طلبات CORS OPTIONS
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    // التوجيه لنقطة نهاية عرض الملف الجديد (GET /stream_file)
    if (pathname.startsWith('/stream_file') && req.method === 'GET') {
        return handleStream(req);
    }
    
    // التوجيه لنقطة نهاية الرفع (POST /upload_file)
    if (pathname.startsWith('/upload_file') && req.method === 'POST') {
        return handleUpload(req);
    }
    
    // رسالة خطأ للمسارات غير المعروفة
    return new Response(
        JSON.stringify({ success: false, message: 'Endpoint not found.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
});
