/**
 * Telegram 双向机器人 Cloudflare Worker
 * 实现了：人机验证、私聊到话题模式的转发、管理员回复中继、话题名动态更新、已编辑消息处理、用户屏蔽功能、关键词自动回复
 * [修改] 存储已从 Cloudflare KV 切换到 D1 (SQLite) 以获取更高的写入容量。
 * [新增] 完整的管理员配置菜单，包括：验证配置、自动回复、关键词屏蔽和按类型过滤。
 * [修复] 修复了管理员配置输入后，用户状态未被正确标记为“已验证”，导致下一个消息流程出错的问题。
 * [新增] 在按类型过滤中增加了：所有转发消息、音频/语音、贴纸/GIF 的过滤开关。
 * [重构] 彻底重构了自动回复和关键词屏蔽的管理界面，引入了列表、新增、删除功能。
 * [新增] 完整的管理员配置菜单。
 * [新增] 备份群组功能：配置一个群组，用于接收所有用户消息的副本，不参与回复。
 * [新增] 协管员授权功能：允许设置额外的管理员ID，他们可以绕过私聊验证并回复用户消息。
 * * 部署要求: 
 * 1. D1 数据库绑定，名称必须为 'TG_BOT_DB'。
 * 2. 环境变量 ADMIN_IDS, BOT_TOKEN, ADMIN_GROUP_ID, 等不变。
 * * [修复] 解决用户首次验证通过后需要再发送一次消息的问题。
 * [修复] 解决管理员在话题中编辑回复，用户收不到的问题。
 * [修复] 解决用户回答正确的验证答案时，该消息也被转发的问题。
 * [新增] 增强管理员编辑消息通知，包含旧内容、旧时间、新内容和新编辑时间，以镜像用户编辑通知。
 */


// --- 辅助函数 (D1 数据库抽象层) ---

/**
 * [D1 Abstraction] 获取全局配置 (config table)
 */
async function dbConfigGet(key, env) {
    const row = await env.TG_BOT_DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first();
    return row ? row.value : null;
  }
  
  /**
  * [D1 Abstraction] 设置/更新全局配置 (config table)
  */
  async function dbConfigPut(key, value, env) {
    // INSERT OR REPLACE 确保如果键已存在则更新，否则插入
    await env.TG_BOT_DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(key, value).run();
  }
  
  /**
  * [D1 Abstraction] 确保用户在 users 表中存在，并返回其数据。
  * 如果用户不存在，则创建默认记录。
  */
  async function dbUserGetOrCreate(userId, env) {
    let user = await env.TG_BOT_DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
  
    if (!user) {
        // 插入默认记录
        await env.TG_BOT_DB.prepare(
            "INSERT INTO users (user_id, user_state, is_blocked, block_count) VALUES (?, 'new', 0, 0)"
        ).bind(userId).run();
        // 重新查询以获取完整的默认记录
        user = await env.TG_BOT_DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
    }
    
    // 将 is_blocked 转换为布尔值，并解析 JSON 字段
    if (user) {
        user.is_blocked = user.is_blocked === 1;
        user.user_info = user.user_info_json ? JSON.parse(user.user_info_json) : null;
    }
    return user;
  }
  
  /**
  * [D1 Abstraction] 更新 users 表中的一个或多个字段
  * data 应该是一个包含要更新字段的对象 { topic_id: '...', user_state: '...' }
  */
  async function dbUserUpdate(userId, data, env) {
    // 确保 user_info_json 是 JSON 字符串
    if (data.user_info) {
        data.user_info_json = JSON.stringify(data.user_info);
        delete data.user_info; // 移除原始对象以避免与 SQL 冲突
    }
    
    // 构造 SQL 语句
    const fields = Object.keys(data).map(key => {
        // 特殊处理 is_blocked (布尔值) 和 block_count (数字)
        if (key === 'is_blocked' && typeof data[key] === 'boolean') {
             return 'is_blocked = ?'; // D1 存储 0/1
        }
        return `${key} = ?`;
    }).join(', ');
    
    // 构造值数组
    const values = Object.keys(data).map(key => {
         if (key === 'is_blocked' && typeof data[key] === 'boolean') {
             return data[key] ? 1 : 0;
         }
         return data[key];
    });
    
    await env.TG_BOT_DB.prepare(`UPDATE users SET ${fields} WHERE user_id = ?`).bind(...values, userId).run();
  }
  
  /**
  * [D1 Abstraction] 根据 topic_id 查找 user_id
  */
  async function dbTopicUserGet(topicId, env) {
    const row = await env.TG_BOT_DB.prepare("SELECT user_id FROM users WHERE topic_id = ?").bind(topicId).first();
    return row ? row.user_id : null;
  }
  
  /**
  * [D1 Abstraction] 存入消息数据 (messages table)
  * 用于已编辑消息跟踪。
  */
  async function dbMessageDataPut(userId, messageId, data, env) {
    // data 包含 { text, date }
    await env.TG_BOT_DB.prepare(
        "INSERT OR REPLACE INTO messages (user_id, message_id, text, date) VALUES (?, ?, ?, ?)"
    ).bind(userId, messageId, data.text, data.date).run();
  }
  
  /**
  * [D1 Abstraction] 获取消息数据 (messages table)
  * 用于已编辑消息跟踪。
  */
  async function dbMessageDataGet(userId, messageId, env) {
    const row = await env.TG_BOT_DB.prepare(
        "SELECT text, date FROM messages WHERE user_id = ? AND message_id = ?"
    ).bind(userId, messageId).first();
    return row || null;
  }
  
  
  /**
  * [D1 Abstraction] 清除管理员编辑状态
  */
  async function dbAdminStateDelete(userId, env) {
    await env.TG_BOT_DB.prepare("DELETE FROM config WHERE key = ?").bind(`admin_state:${userId}`).run();
  }
  
  /**
  * [D1 Abstraction] 获取管理员编辑状态
  */
  async function dbAdminStateGet(userId, env) {
    const stateJson = await dbConfigGet(`admin_state:${userId}`, env);
    return stateJson || null;
  }
  
  /**
  * [D1 Abstraction] 设置管理员编辑状态
  */
  async function dbAdminStatePut(userId, stateJson, env) {
    await dbConfigPut(`admin_state:${userId}`, stateJson, env);
  }
  
  /**
  * [D1 Abstraction] D1 数据库迁移/初始化函数
  * 确保所需的表存在。
  */
  async function dbMigrate(env) {
    // 确保 D1 绑定存在
    if (!env.TG_BOT_DB) {
        throw new Error("D1 database binding 'TG_BOT_DB' is missing.");
    }
    
    // config 表
    const configTableQuery = `
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `;
  
    // users 表 (存储用户状态、话题ID、屏蔽状态和用户信息)
    const usersTableQuery = `
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY NOT NULL,
            user_state TEXT NOT NULL DEFAULT 'new',
            is_blocked INTEGER NOT NULL DEFAULT 0,
            block_count INTEGER NOT NULL DEFAULT 0,
            topic_id TEXT,
            user_info_json TEXT 
        );
    `;
    
    // messages 表 (存储消息内容用于处理已编辑消息)
    const messagesTableQuery = `
        CREATE TABLE IF NOT EXISTS messages (
            user_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            text TEXT,
            date INTEGER,
            PRIMARY KEY (user_id, message_id)
        );
    `;
  
    // 按批次执行所有创建表的语句
    try {
        await env.TG_BOT_DB.batch([
            env.TG_BOT_DB.prepare(configTableQuery),
            env.TG_BOT_DB.prepare(usersTableQuery),
            env.TG_BOT_DB.prepare(messagesTableQuery),
        ]);
        // console.log("D1 Migration successful/already complete.");
    } catch (e) {
        console.error("D1 Migration Failed:", e);
        throw new Error(`D1 Initialization Failed: ${e.message}`);
    }
  }
  
  
  // --- 辅助函数 ---
  
  function escapeHtml(text) {
  if (!text) return '';
  // Cloudflare Worker 不支持 String.prototype.replaceAll, 使用全局替换
  return text.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  
  /**
   * 将 Unix 时间戳格式化为 YYYY/MM/DD HH:MM:SS 格式的本地时间字符串。
   * @param {number} unixTimestamp - Unix 时间戳 (秒)
   * @returns {string} 格式化后的时间字符串
   */
  function formatTimestamp(unixTimestamp) {
      if (!unixTimestamp) return "N/A";
      const date = new Date(unixTimestamp * 1000);
      // 使用 locale-aware format for clarity
      return date.toLocaleString('zh-CN', { 
          year: 'numeric', 
          month: '2-digit', 
          day: '2-digit', 
          hour: '2-digit', 
          minute: '2-digit', 
          second: '2-digit', 
          hour12: false 
      });
  }
  
  function getUserInfo(user, initialTimestamp = null) {
    const userId = user.id.toString();
    const rawName = (user.first_name || "") + (user.last_name ? ` ${user.last_name}` : "");
    const rawUsername = user.username ? `@${user.username}` : "无";
    
    const safeName = escapeHtml(rawName);
    const safeUsername = escapeHtml(rawUsername);
    const safeUserId = escapeHtml(userId);
  
    const topicName = `${rawName.trim()} | ${userId}`.substring(0, 128);
  
    const timestamp = initialTimestamp ? formatTimestamp(initialTimestamp) : formatTimestamp(Math.floor(Date.now() / 1000));
    
    const infoCard = `
  <b>👤 用户资料卡</b>
  ---
  • 昵称/名称: <code>${safeName}</code>
  • 用户名: <code>${safeUsername}</code>
  • ID: <code>${safeUserId}</code>
  • 首次连接时间: <code>${timestamp}</code>
    `.trim();
  
    return { userId, name: rawName, username: rawUsername, topicName, infoCard };
  }
  
  /**
  * 生成用户资料卡下方的操作按钮（屏蔽/解禁/置顶）
  */
  function getInfoCardButtons(userId, isBlocked) {
    const blockAction = isBlocked ? "unblock" : "block";
    const blockText = isBlocked ? "✅ 解除屏蔽 (Unblock)" : "🚫 屏蔽此人 (Block)";
    return {
        inline_keyboard: [
            [{ // Row 1: Block/Unblock Button
                text: blockText,
                callback_data: `${blockAction}:${userId}`
            }],
            [{ // Row 2: Pin Button
                text: "📌 置顶此消息 (Pin Card)",
                callback_data: `pin_card:${userId}` 
            }]
        ]
    };
  }
  
  
  /**
  * 优先从 D1 获取配置，其次从环境变量获取，最后使用默认值。
  */
  async function getConfig(key, env, defaultValue) {
    const configValue = await dbConfigGet(key, env);
    
    // 如果 D1 中有配置，直接返回 D1 的值
    if (configValue !== null) {
        return configValue;
    }
    
    // 如果 D1 中没有，检查环境变量（作为后备或兼容性）
    const envKey = key.toUpperCase()
                      .replace('WELCOME_MSG', 'WELCOME_MESSAGE')
                      .replace('VERIF_Q', 'VERIFICATION_QUESTION')
                      .replace('VERIF_A', 'VERIFICATION_ANSWER')
                      .replace(/_FORWARDING/g, '_FORWARDING');
    
    const envValue = env[envKey];
    if (envValue !== undefined && envValue !== null) {
        return envValue;
    }
    
    // 都没有，返回代码默认值
    return defaultValue;
  }
  
  /**
  * 检查用户是否是主管理员 (来自 ADMIN_IDS 环境变量)
  */
  function isPrimaryAdmin(userId, env) {
    if (!env.ADMIN_IDS) return false;
    // 确保 ADMIN_IDS 是逗号分隔的字符串
    const adminIds = env.ADMIN_IDS.split(',').map(id => id.trim());
    return adminIds.includes(userId.toString());
  }
  
  
  /**
  * [新增] 获取授权协管员 ID 列表
  */
  async function getAuthorizedAdmins(env) {
    const jsonString = await getConfig('authorized_admins', env, '[]');
    try {
        const adminList = JSON.parse(jsonString);
        // 确保列表是有效的数组，并且所有元素都被修剪并转换为字符串
        return Array.isArray(adminList) ? adminList.map(id => id.toString().trim()).filter(id => id !== "") : [];
    } catch (e) {
        console.error("Failed to parse authorized_admins from D1:", e);
        return [];
    }
  }
  
  /**
  * 检查用户是否是任意管理员 (主管理员或授权协管员)
  */
  async function isAdminUser(userId, env) {
    // 1. 检查是否是主管理员 (ADMIN_IDS 环境变量)
    if (isPrimaryAdmin(userId, env)) {
        return true;
    }
  
    // 2. 检查是否是授权协管员 (D1 配置)
    const authorizedAdmins = await getAuthorizedAdmins(env);
    return authorizedAdmins.includes(userId.toString());
  }
  
  
  // --- 规则管理重构区域 ---
  
  /**
  * 获取自动回复规则列表（从 JSON 字符串解析为数组）
  * 结构：[{ keywords: "a|b", response: "reply", id: timestamp }, ...]
  */
  async function getAutoReplyRules(env) {
    // 尝试从 D1 获取配置，默认值是空数组的 JSON 字符串
    const jsonString = await getConfig('keyword_responses', env, '[]');
    try {
        const rules = JSON.parse(jsonString);
        return Array.isArray(rules) ? rules : [];
    } catch (e) {
        console.error("Failed to parse keyword_responses from D1:", e);
        return [];
    }
  }
  
  /**
  * 获取屏蔽关键词列表（从 JSON 字符串解析为数组）
  * 结构：["keyword1|keyword2", "keyword3", ...]
  */
  async function getBlockKeywords(env) {
    // 尝试从 D1 获取配置，默认值是空数组的 JSON 字符串
    const jsonString = await getConfig('block_keywords', env, '[]');
    try {
        const keywords = JSON.parse(jsonString);
        return Array.isArray(keywords) ? keywords : [];
    } catch (e) {
        console.error("Failed to parse block_keywords from D1:", e);
        return [];
    }
  }
  
  
  // --- API 客户端 ---
  
  async function telegramApi(token, methodName, params = {}) {
    const url = `https://api.telegram.org/bot${token}/${methodName}`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
    });
  
    let data;
    try {
        data = await response.json();
    } catch (e) {
        console.error(`Telegram API ${methodName} 返回非 JSON 响应`);
        throw new Error(`Telegram API ${methodName} returned non-JSON response`);
    }
  
    if (!data.ok) {
        // 捕获 API 错误，用于话题不存在等场景
        // console.error(`Telegram API error (${methodName}): ${data.description}. Params: ${JSON.stringify(params)}`);
        throw new Error(`${methodName} failed: ${data.description || JSON.stringify(data)}`);
    }
  
    return data.result;
  }
  
  
  // --- 核心更新处理函数 ---
  
  export default {
  async fetch(request, env, ctx) {
      // 关键修正：在处理任何请求之前，先运行数据库迁移，确保表结构存在。
      try {
            await dbMigrate(env);
      } catch (e) {
            // 如果迁移失败，直接返回错误，防止后续 D1 调用失败
            return new Response(`D1 Database Initialization Error: ${e.message}`, { status: 500 });
      }
  
      if (request.method === "POST") {
          try {
              const update = await request.json();
              // 使用 ctx.waitUntil 确保异步处理不会被 Worker 提前终止
              ctx.waitUntil(handleUpdate(update, env)); 
          } catch (e) {
              console.error("处理更新时出错:", e);
          }
      }
      return new Response("OK");
  },
  };
  
  async function handleUpdate(update, env) {
    if (update.message) {
        if (update.message.chat.type === "private") {
            await handlePrivateMessage(update.message, env);
        }
        else if (update.message.chat.id.toString() === env.ADMIN_GROUP_ID) {
            await handleAdminReply(update.message, env);
        }
    } else if (update.edited_message) {
        if (update.edited_message.chat.type === "private") {
            await handleRelayEditedMessage(update.edited_message, env);
        }
        // [BUG 1 FIX]：新增处理管理员群组的编辑消息
        else if (update.edited_message.chat.id.toString() === env.ADMIN_GROUP_ID) {
            await handleAdminEditedReply(update.edited_message, env);
        }
    } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
    } 
  }
  
  async function handlePrivateMessage(message, env) {
    const chatId = message.chat.id.toString();
    const text = message.text || "";
    const userId = chatId;
  
    // 检查是否是主管理员 (只有主管理员能访问配置菜单)
    const isPrimary = isPrimaryAdmin(userId, env);
    // 检查是否是任意管理员 (主管理员或授权协管员)
    const isAdmin = await isAdminUser(userId, env);
    // 从 D1 获取用户数据
    const user = await dbUserGetOrCreate(userId, env);  
    
    // 1. 检查 /start 或 /help 命令
    if (text === "/start" || text === "/help") {
        if (isPrimary) { await handleAdminConfigStart(chatId, env); return; }
        if (user.user_state === "verified") {
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "你已完成验证，可以直接发送消息。", });
            return;
        }
        await handleStart(chatId, env); // 只对未验证用户送题
        return;
    }
    
    const isBlocked = user.is_blocked;
  
    if (isBlocked) {
        return; 
    }
    
    // 主管理员在配置编辑状态中发送的文本输入
    if (isPrimary) {
        const adminStateJson = await dbAdminStateGet(userId, env);
        if (adminStateJson) {
            await handleAdminConfigInput(userId, text, adminStateJson, env);
            return;
        }
        
        // --- 核心修复: 确保主管理员用户跳过验证 ---
        if (user.user_state !== "verified") {
            // 更新本地 user 对象和 D1 数据库
            user.user_state = "verified"; 
            await dbUserUpdate(userId, { user_state: "verified" }, env); 
        }
        // --- 修复结束 ---
    }
    
    // --- [新增] 协管员绕过验证逻辑 ---
    if (isAdmin && user.user_state !== "verified") {
        user.user_state = "verified"; 
        await dbUserUpdate(userId, { user_state: "verified" }, env); 
    }
    // --- [新增] 协管员绕过验证逻辑结束 ---
  
    // 2. 检查用户的验证状态
    let userState = user.user_state; 
  
    if (userState === "pending_verification") {
        const isVerifiedNow = await handleVerification(chatId, text, env); 
        
        if (isVerifiedNow) {
            // [BUG FIX]: 验证成功后，立即退出函数，防止验证答案被转发。
            // D1 状态已更新，下一条消息将正常转发。
            return; 
        } else {
            return; // 验证失败，退出
        }
    }
  
    if (userState === "verified") {
        
        // --- [关键词屏蔽检查] ---
        const blockKeywords = await getBlockKeywords(env); // 获取 JSON 数组
        const blockThreshold = parseInt(await getConfig('block_threshold', env, "5"), 10) || 5; 
        
        if (blockKeywords.length > 0 && text) { 
            let currentCount = user.block_count;
            
            for (const keyword of blockKeywords) {
                try {
                    // 使用新结构中的字符串构建 RegExp
                    const regex = new RegExp(keyword, 'gi'); 
                    if (regex.test(text)) {
                        currentCount += 1;
                        
                        // 更新 D1 中的屏蔽计数
                        await dbUserUpdate(userId, { block_count: currentCount }, env);
                        
                        const blockNotification = `⚠️ 您的消息触发了屏蔽关键词过滤器 (${currentCount}/${blockThreshold}次)，此消息已被丢弃，不会转发给对方。`;
                        
                        if (currentCount >= blockThreshold) {
                            // 达到阈值，自动屏蔽用户 (is_blocked = 1)
                            await dbUserUpdate(userId, { is_blocked: true }, env);
                            const autoBlockMessage = `❌ 您已多次触发屏蔽关键词，根据设置，您已被自动屏蔽。机器人将不再接收您的任何消息。`;
                            
                            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: blockNotification });
                            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: autoBlockMessage });
                            return;
                        }
                        
                        await telegramApi(env.BOT_TOKEN, "sendMessage", {
                            chat_id: chatId,
                            text: blockNotification,
                        });
  
                        return; 
                    }
                } catch(e) {
                    console.error("Invalid keyword block regex:", keyword, e);
                    // 忽略无效的正则，继续检查下一个
                }
            }
        }
  
        // --- [转发内容过滤检查] ---
        const filters = {
            // 图片/视频/文件 (原 enable_image_forwarding)
            media: (await getConfig('enable_image_forwarding', env, 'true')).toLowerCase() === 'true',
            // 链接
            link: (await getConfig('enable_link_forwarding', env, 'true')).toLowerCase() === 'true',
            // 纯文本
            text: (await getConfig('enable_text_forwarding', env, 'true')).toLowerCase() === 'true',
            // 频道转发 (细分)
            channel_forward: (await getConfig('enable_channel_forwarding', env, 'true')).toLowerCase() === 'true', 
            
            // 新增过滤器
            // 任何转发消息 (用户/群组/频道)
            any_forward: (await getConfig('enable_forward_forwarding', env, 'true')).toLowerCase() === 'true', 
            // 音频文件和语音消息
            audio_voice: (await getConfig('enable_audio_forwarding', env, 'true')).toLowerCase() === 'true', 
            // 贴纸，emojy，gif (sticker, animation)
            sticker_gif: (await getConfig('enable_sticker_forwarding', env, 'true')).toLowerCase() === 'true', 
        };
  
        let isForwardable = true;
        let filterReason = '';
  
        const hasLinks = (msg) => {
            const entities = msg.entities || msg.caption_entities || [];
            return entities.some(entity => entity.type === 'url' || entity.type === 'text_link');
        };
  
        // 1. 任何转发消息（用户、群组、频道）
        if (message.forward_from || message.forward_from_chat) {
             // 检查总开关
             if (!filters.any_forward) {
                isForwardable = false;
                filterReason = '转发消息 (来自用户/群组/频道)';
            } 
            // 如果总开关允许，但它是频道转发，再检查频道细分开关
            else if (message.forward_from_chat && message.forward_from_chat.type === 'channel' && !filters.channel_forward) {
                isForwardable = false;
                filterReason = '频道转发消息';
            }
        } 
        // 2. 音频文件和语音消息
        else if (message.audio || message.voice) {
            if (!filters.audio_voice) {
                isForwardable = false;
                filterReason = '音频或语音消息';
            }
        }
        // 3. 贴纸，emojy，gif (sticker, animation)
        else if (message.sticker || message.animation) {
             if (!filters.sticker_gif) {
                isForwardable = false;
                filterReason = '贴纸或GIF';
            }
        }
        // 4. 其他媒体（Photo, Video, Document） - 使用 'media' (原 enable_image_forwarding)
        else if (message.photo || message.video || message.document) {
            if (!filters.media) {
                isForwardable = false;
                filterReason = '媒体内容（图片/视频/文件）';
            }
        } 
        
        // 5. 链接检查 (保留原逻辑，作用于任何包含链接的消息)
        if (isForwardable && hasLinks(message)) {
            if (!filters.link) {
                isForwardable = false;
                filterReason = filterReason ? `${filterReason} (并包含链接)` : '包含链接的内容';
            }
        }
  
        // 6. 纯文本检查 (保留原逻辑)
        // 检查是否是纯文本（排除所有媒体和转发类型）
        const isPureText = message.text && 
                           !message.photo && !message.video && !message.document && 
                           !message.sticker && !message.audio && !message.voice && 
                           !message.forward_from_chat && !message.forward_from && !message.animation; 
        
        if (isForwardable && isPureText) {
            if (!filters.text) {
                isForwardable = false;
                filterReason = '纯文本内容';
            }
        }
  
        if (!isForwardable) {
            const filterNotification = `此消息已被过滤：${filterReason}。根据设置，此类内容不会转发给对方。`;
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: chatId,
                text: filterNotification,
            });
            return; 
        }
        
        // --- [Keyword Auto-Reply Check] ---
        const autoResponseRules = await getAutoReplyRules(env); // 获取 JSON 数组
        if (autoResponseRules.length > 0 && text) { 
            
            for (const rule of autoResponseRules) {
                try {
                    // 使用新结构中的 keywords 字符串构建 RegExp
                    const regex = new RegExp(rule.keywords, 'gi'); 
                    if (regex.test(text)) {
                        const autoReplyPrefix = "此消息为自动回复\n\n";
                        await telegramApi(env.BOT_TOKEN, "sendMessage", {
                            chat_id: chatId,
                            text: autoReplyPrefix + rule.response,
                        });
                        return; 
                    }
                } catch(e) {
                    console.error("Invalid auto-reply regex:", rule.keywords, e);
                    // 忽略无效的正则，继续检查下一个
                }
            }
        }
        
        await handleRelayToTopic(message, user, env); // 传递 user 对象
        
    } else {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "请使用 /start 命令开始。",
        });
    }
  }
  
  // --- 验证逻辑 (使用 D1) ---
  
  async function handleStart(chatId, env) {
    const u = await dbUserGetOrCreate(chatId, env);
    if (u.user_state === "verified") {
      // 已验证用户不降级
      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "你已完成验证，直接发消息即可。" });
      return;
    }
    
    const welcomeMessage = await getConfig('welcome_msg', env, "欢迎！在使用之前，请先完成人机验证。");
    
    const defaultVerificationQuestion = 
        "问题：1+1=?\n\n" +
        "提示：\n" +
        "1. 正确答案不是“2”。\n" +
        "2. 答案在机器人简介内，请看简介的答案进行回答。";
        
    const verificationQuestion = await getConfig('verif_q', env, defaultVerificationQuestion);
  
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: welcomeMessage });
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: verificationQuestion });
    
    // 更新 D1 中的用户状态
    if (u.user_state !== "pending_verification") {
        await dbUserUpdate(chatId, { user_state: "pending_verification" }, env);
    }
  }
  
  async function handleVerification(chatId, answer, env) {
    const raw = await getConfig('verif_a', env, "3");
    const norm = s => { try { return s.normalize("NFKC").trim().toLowerCase(); } catch { return (s||"").trim().toLowerCase(); } };
    const candidates = (() => { try { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr; } catch(_){} return String(raw).split('|'); })().map(norm);
  
    if (candidates.includes(norm(answer))) {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "✅ 验证通过！您现在可以发送消息了。",
        });
        // 更新 D1 中的用户状态
        await dbUserUpdate(chatId, { user_state: "verified" }, env);
        return true; // [BUG 2 FIX]：成功返回 true
    } else {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "❌ 验证失败！\n请查看机器人简介查找答案，然后重新回答。",
        });
        return false; // [BUG 2 FIX]：失败返回 false
    }
  }
  
  /**
   * [修改] 处理管理员在话题中修改消息的逻辑。
   * 现在会查询原始消息内容和时间，并以详细格式通知用户。
   */
  async function handleAdminEditedReply(editedMessage, env) {
      // 检查是否是话题内的消息
      if (!editedMessage.is_topic_message || !editedMessage.message_thread_id) return;
  
      // 检查是否来自管理员群组
      const adminGroupIdStr = env.ADMIN_GROUP_ID.toString();
      if (editedMessage.chat.id.toString() !== adminGroupIdStr) return;
  
      // 忽略机器人自己的消息
      if (editedMessage.from && editedMessage.from.is_bot) return;
  
      // 检查消息发送者是否是授权协管员或主管理员
      const senderId = editedMessage.from.id.toString();
      const isAuthorizedAdmin = await isAdminUser(senderId, env);
      
      if (!isAuthorizedAdmin) {
          return; 
      }
  
      const topicId = editedMessage.message_thread_id.toString();
      // 从 D1 根据 topic_id 查找 user_id (私聊目标)
      const userId = await dbTopicUserGet(topicId, env);
      if (!userId) return;
  
      // 1. 从消息表中查找原始消息的文本和发送日期
      const messageId = editedMessage.message_id.toString();
      // 使用 user_id (私聊ID) + messageId (管理员群组消息ID) 作为键
      const storedMessage = await dbMessageDataGet(userId, messageId, env);
      if (!storedMessage) return; // 找不到原始消息，无法通知
  
      const newText = editedMessage.text || editedMessage.caption || "[媒体内容]";
  
      // 2. 格式化时间
      // storedMessage.date 存储的是原发送时间或上次编辑后的时间
      const originalTime = formatTimestamp(storedMessage.date); 
      // editedMessage.edit_date 是本次编辑的时间
      const editTime = formatTimestamp(editedMessage.edit_date || editedMessage.date); 
      
      // 3. 构造通知文本 (使用 HTML 解析模式以支持 <b> 和 <code>)
      const notificationText = `
  ⚠️ <b>管理员编辑了回复</b>
  ---
  <b>原发送/上次编辑时间:</b> <code>${originalTime}</code>
  <b>本次编辑时间:</b> <code>${editTime}</code>
  ---
  <b>原消息内容：</b>
  ${escapeHtml(storedMessage.text)}
  ---
  <b>新消息内容：</b>
  ${escapeHtml(newText)}
      `.trim();
  
      try {
          await telegramApi(env.BOT_TOKEN, "sendMessage", {
              chat_id: userId,
              text: notificationText,
              parse_mode: "HTML",
          });
  
          // 4. 更新消息表中的存储内容 (用于下次编辑时作为"原消息")
          await dbMessageDataPut(userId, messageId, { text: newText, date: editedMessage.edit_date || editedMessage.date }, env);
  
      } catch (e) {
          // 如果发送失败，记录错误
          console.error("handleAdminEditedReply: Failed to send edited message to user:", e?.message || e);
      }
  }
  
  // --- 管理员配置主菜单逻辑 (使用 D1) ---
  
  async function handleAdminConfigStart(chatId, env, messageId = null) {
    const isPrimary = isPrimaryAdmin(chatId, env);
    if (!isPrimary) {
        // 非主管理员不显示配置菜单
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "您是授权协管员，已绕过验证。此菜单仅供主管理员使用。", });
        return;
    }
    
    const menuText = `
  ⚙️ <b>机器人主配置菜单</b>
  
  请选择要管理的配置类别：
    `.trim();
  
    const menuKeyboard = {
        inline_keyboard: [
            // 第一行：配置
            [{ text: "📝 基础配置 (验证问答)", callback_data: "config:menu:base" }],
            // 第二行：功能
            [{ text: "🤖 自动回复管理", callback_data: "config:menu:autoreply" }],
            [{ text: "🚫 关键词屏蔽管理", callback_data: "config:menu:keyword" }],
            // 第三行：过滤
            [{ text: "🔗 按类型过滤管理", callback_data: "config:menu:filter" }],
            // 协管员授权设置按钮
            [{ text: "🧑‍💻 协管员授权设置", callback_data: "config:menu:authorized" }], 
            // 备份群组设置按钮
            [{ text: "💾 备份群组设置", callback_data: "config:menu:backup" }], 
            // 第四行：刷新
            [{ text: "🔄 刷新主菜单", callback_data: "config:menu" }],
        ]
    };
  
    // 清除任何未完成的编辑状态
    await dbAdminStateDelete(chatId, env);
  
    // 检查是否是编辑旧消息的回调（从其他子菜单返回）
    if (messageId) {
        const params = {
            chat_id: chatId,
            message_id: messageId,
            text: menuText,
            parse_mode: "HTML",
            reply_markup: menuKeyboard,
        };
        await telegramApi(env.BOT_TOKEN, "editMessageText", params).catch(e => console.error("尝试编辑旧菜单失败:", e.message)); // 忽略编辑失败
        return;
    }
  
  
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
    });
  }
  
  /**
  * 基础配置子菜单 - 兼容编辑和发送新消息
  */
  async function handleAdminBaseConfigMenu(chatId, messageId, env) {
    const welcomeMsg = await getConfig('welcome_msg', env, "欢迎！...");
    const verifQ = await getConfig('verif_q', env, "问题：1+1=?...");
    const verifA = await getConfig('verif_a', env, "3");
  
    const menuText = `
  ⚙️ <b>基础配置 (人机验证)</b>
  
  <b>当前设置:</b>
  • 欢迎消息: ${escapeHtml(welcomeMsg).substring(0, 30)}...
  • 验证问题: ${escapeHtml(verifQ).substring(0, 30)}...
  • 验证答案: <code>${escapeHtml(verifA)}</code>
  
  请选择要修改的配置项:
    `.trim();
  
    const menuKeyboard = {
        inline_keyboard: [
            [{ text: "📝 编辑欢迎消息", callback_data: "config:edit:welcome_msg" }],
            [{ text: "❓ 编辑验证问题", callback_data: "config:edit:verif_q" }],
            [{ text: "🔑 编辑验证答案", callback_data: "config:edit:verif_a" }],
            [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
        ]
    };
  
    const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
    const params = {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
    };
    if (apiMethod === "editMessageText") {
        params.message_id = messageId;
    }
    await telegramApi(env.BOT_TOKEN, apiMethod, params);
  }
  
  /**
  * [新增] 协管员授权设置子菜单
  */
  async function handleAdminAuthorizedConfigMenu(chatId, messageId, env) {
    const primaryAdmins = env.ADMIN_IDS ? env.ADMIN_IDS.split(',').map(id => id.trim()).filter(id => id !== "") : [];
    const authorizedAdmins = await getAuthorizedAdmins(env);
    
    const allAdmins = [...new Set([...primaryAdmins, ...authorizedAdmins])]; // 合并并去重
    const authorizedCount = authorizedAdmins.length;
  
    const menuText = `
  🧑‍💻 <b>协管员授权设置</b>
  
  <b>主管理员 (来自 ENV):</b> <code>${primaryAdmins.join(', ')}</code>
  <b>已授权协管员 (来自 D1):</b> <code>${authorizedAdmins.join(', ') || '无'}</code>
  <b>总管理员/协管员数量:</b> ${allAdmins.length} 人
  
  <b>注意：</b>
  1. 协管员 ID 或用户名必须与群组话题中的回复者一致。
  2. 协管员的私聊会自动绕过验证。
  3. 输入格式：ID 或用户名，多个用逗号分隔。
  
  请选择要修改的配置项:
    `.trim();
  
    const menuKeyboard = {
        inline_keyboard: [
            [{ text: "✏️ 设置/修改协管员列表", callback_data: "config:edit:authorized_admins" }],
            [{ text: `🗑️ 清空协管员列表 (${authorizedCount}人)`, callback_data: "config:edit:authorized_admins_clear" }],
            [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
        ]
    };
  
    const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
    const params = {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
    };
    if (apiMethod === "editMessageText") {
        params.message_id = messageId;
    }
    await telegramApi(env.BOT_TOKEN, apiMethod, params);
  }
  
  /**
  * 自动回复子菜单 - 兼容编辑和发送新消息
  */
  async function handleAdminAutoReplyMenu(chatId, messageId, env) {
    const rules = await getAutoReplyRules(env);
    const ruleCount = rules.length;
    
    const menuText = `
  🤖 <b>自动回复管理</b>
  
  当前规则总数：<b>${ruleCount}</b> 条。
  
  请选择操作：
    `.trim();
  
    const menuKeyboard = {
        inline_keyboard: [
            [{ text: "➕ 新增自动回复规则", callback_data: "config:add:keyword_responses" }],
            [{ text: `🗑️ 管理/删除现有规则 (${ruleCount}条)`, callback_data: "config:list:keyword_responses" }],
            [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
        ]
    };
  
    const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
    const params = {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
    };
    if (apiMethod === "editMessageText") {
        params.message_id = messageId;
    }
    await telegramApi(env.BOT_TOKEN, apiMethod, params);
  }
  
  /**
  * 关键词屏蔽子菜单 - 兼容编辑和发送新消息
  */
  async function handleAdminKeywordBlockMenu(chatId, messageId, env) {
    const blockKeywords = await getBlockKeywords(env);
    const keywordCount = blockKeywords.length;
    const blockThreshold = await getConfig('block_threshold', env, "5");
  
    const menuText = `
  🚫 <b>关键词屏蔽管理</b>
  
  当前屏蔽关键词总数：<b>${keywordCount}</b> 个。
  屏蔽次数阈值：<code>${escapeHtml(blockThreshold)}</code> 次。
  
  请选择操作：
    `.trim();
  
    const menuKeyboard = {
        inline_keyboard: [
            [{ text: "➕ 新增屏蔽关键词", callback_data: "config:add:block_keywords" }],
            [{ text: `🗑️ 管理/删除现有关键词 (${keywordCount}个)`, callback_data: "config:list:block_keywords" }],
            [{ text: "✏️ 修改屏蔽次数阈值", callback_data: "config:edit:block_threshold" }],
            [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
        ]
    };
  
    const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
    const params = {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
    };
    if (apiMethod === "editMessageText") {
        params.message_id = messageId;
    }
    await telegramApi(env.BOT_TOKEN, apiMethod, params);
  }
  
  /**
  * [新增] 备份群组设置子菜单 - 兼容编辑和发送新消息
  */
  async function handleAdminBackupConfigMenu(chatId, messageId, env) {
    // 备份群组 ID 存储在 'backup_group_id' 键中
    const backupGroupId = await getConfig('backup_group_id', env, "未设置"); 
    const backupStatus = backupGroupId !== "未设置" && backupGroupId !== "" ? "✅ 已启用" : "❌ 未启用";
  
    const menuText = `
  💾 <b>备份群组设置</b>
  
  <b>当前设置:</b>
  • 状态: ${backupStatus}
  • 备份群组 ID: <code>${escapeHtml(backupGroupId)}</code>
  
  <b>注意：</b>此群组仅用于备份消息，不参与管理员回复中继等互动功能。
  群组 ID 可以是数字 ID 或 \`@group_username\`。如果设置为空，则禁用备份。
  
  请选择要修改的配置项:
    `.trim();
  
    const menuKeyboard = {
        inline_keyboard: [
            [{ text: "✏️ 设置/修改备份群组 ID", callback_data: "config:edit:backup_group_id" }],
            [{ text: "❌ 清除备份群组 ID (禁用备份)", callback_data: "config:edit:backup_group_id_clear" }],
            [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
        ]
    };
  
    const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
    const params = {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
    };
    if (apiMethod === "editMessageText") {
        params.message_id = messageId;
    }
    await telegramApi(env.BOT_TOKEN, apiMethod, params);
  }
  
  
  /**
  * [新增] 规则列表和删除界面
  */
  async function handleAdminRuleList(chatId, messageId, env, key) {
    let rules = [];
    let menuText = "";
    let backCallback = "";
  
    if (key === 'keyword_responses') {
        rules = await getAutoReplyRules(env);
        menuText = `
  🤖 <b>自动回复规则列表 (${rules.length}条)</b>
  
  请点击右侧按钮删除对应规则。
  规则格式：<code>关键词表达式</code> ➡️ <code>回复内容</code>
  ---
        `.trim();
        backCallback = "config:menu:autoreply";
    } else if (key === 'block_keywords') {
        rules = await getBlockKeywords(env);
        menuText = `
  🚫 <b>关键词屏蔽列表 (${rules.length}个)</b>
  
  请点击右侧按钮删除对应关键词。
  关键词格式：<code>关键词表达式</code>
  ---
        `.trim();
        backCallback = "config:menu:keyword";
    } else {
        return;
    }
  
    const ruleButtons = [];
    if (rules.length === 0) {
        menuText += "\n\n<i>（列表为空）</i>";
    } else {
        rules.forEach((rule, index) => {
            let label = "";
            let deleteId = "";
            
            if (key === 'keyword_responses') {
                // 自动回复规则：使用 ID 进行删除
                const keywordsSnippet = rule.keywords.substring(0, 15);
                const responseSnippet = rule.response.substring(0, 20);
                label = `${index + 1}. <code>${escapeHtml(keywordsSnippet)}...</code> ➡️ ${escapeHtml(responseSnippet)}...`;
                deleteId = rule.id;
            } else if (key === 'block_keywords') {
                // 屏蔽关键词：直接使用关键词字符串作为 ID (确保唯一)
                const keywordSnippet = rule.substring(0, 25);
                label = `${index + 1}. <code>${escapeHtml(keywordSnippet)}...</code>`;
                deleteId = rule; 
            }
            
            // 添加列表信息到文本
            menuText += `\n${label}`;
  
            // 添加删除按钮
            ruleButtons.push([
                { 
                    text: `🗑️ 删除 ${index + 1}`, 
                    // config:delete:key:id
                    callback_data: `config:delete:${key}:${deleteId}`
                }
            ]);
  
        });
    }
    
    // 底部返回按钮
    ruleButtons.push([{ text: "⬅️ 返回管理菜单", callback_data: backCallback }]);
  
    const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
    const params = {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: ruleButtons },
    };
    if (apiMethod === "editMessageText") {
        params.message_id = messageId;
    }
    await telegramApi(env.BOT_TOKEN, apiMethod, params);
  }
  
  /**
   * [新增] 规则删除逻辑
   */
  async function handleAdminRuleDelete(chatId, messageId, callbackQueryId, env, key, id) {
    let rules = [];
    let typeName = "";
    let backCallback = "";
  
    if (key === 'keyword_responses') {
        rules = await getAutoReplyRules(env);
        typeName = "自动回复规则";
        backCallback = "config:menu:autoreply";
        // 自动回复规则使用 ID 删除
        rules = rules.filter(rule => rule.id.toString() !== id.toString());
    } else if (key === 'block_keywords') {
        rules = await getBlockKeywords(env);
        typeName = "屏蔽关键词";
        backCallback = "config:menu:keyword";
        // 屏蔽关键词直接使用字符串删除
        rules = rules.filter(keyword => keyword !== id);
    } else {
        return;
    }
  
    // 存储更新后的规则列表
    await dbConfigPut(key, JSON.stringify(rules), env);
  
    // BUG FIX: 修复 callback_query_id 使用错误导致通知不显示的 Bug
    await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: callbackQueryId, // 使用正确的 callbackQueryId
        text: `✅ ${typeName}已删除并更新。`,
        show_alert: false
    });
  
    // 刷新列表界面
    await handleAdminRuleList(chatId, messageId, env, key);
  }
  
  /**
  * 按类型过滤子菜单 - 兼容编辑和发送新消息
  */
  async function handleAdminTypeBlockMenu(chatId, messageId, env) {
    // 获取当前状态，检查 D1 -> ENV -> 默认值 'true'
    const mediaStatus = (await getConfig('enable_image_forwarding', env, 'true')).toLowerCase() === 'true'; // 图片/视频/文件
    const linkStatus = (await getConfig('enable_link_forwarding', env, 'true')).toLowerCase() === 'true';
    const textStatus = (await getConfig('enable_text_forwarding', env, 'true')).toLowerCase() === 'true';
    const channelForwardStatus = (await getConfig('enable_channel_forwarding', env, 'true')).toLowerCase() === 'true'; // 频道转发
    const anyForwardStatus = (await getConfig('enable_forward_forwarding', env, 'true')).toLowerCase() === 'true'; // 任何转发
    const audioVoiceStatus = (await getConfig('enable_audio_forwarding', env, 'true')).toLowerCase() === 'true'; // 音频/语音
    const stickerGifStatus = (await getConfig('enable_sticker_forwarding', env, 'true')).toLowerCase() === 'true'; // 贴纸/GIF
  
    const statusToText = (status) => status ? "✅ 允许" : "❌ 屏蔽";
    
    // 构造回调数据：config:toggle:key:new_value (e.g., config:toggle:enable_image_forwarding:false)
    const statusToCallback = (key, status) => `config:toggle:${key}:${status ? 'false' : 'true'}`;
  
    const menuText = `
  🔗 <b>按类型过滤管理</b>
  点击按钮切换转发状态 (切换后立即生效)。
  
  | 类型 | 状态 |
  | :--- | :--- |
  | <b>转发消息（用户/群组/频道）</b>| ${statusToText(anyForwardStatus)} |
  | 频道转发消息 (细分) | ${statusToText(channelForwardStatus)} |
  | <b>音频/语音消息</b> | ${statusToText(audioVoiceStatus)} |
  | <b>贴纸/GIF (动画)</b> | ${statusToText(stickerGifStatus)} |
  | 图片/视频/文件 | ${statusToText(mediaStatus)} |
  | 链接消息 | ${statusToText(linkStatus)} |
  | 纯文本消息 | ${statusToText(textStatus)} |
    `.trim();
  
    const menuKeyboard = {
        inline_keyboard: [
            // 新增的过滤类型
            [{ text: `转发消息 (用户/群组/频道): ${statusToText(anyForwardStatus)}`, callback_data: statusToCallback('enable_forward_forwarding', anyForwardStatus) }],
            [{ text: `音频/语音消息 (Audio/Voice): ${statusToText(audioVoiceStatus)}`, callback_data: statusToCallback('enable_audio_forwarding', audioVoiceStatus) }],
            [{ text: `贴纸/GIF (Sticker/Animation): ${statusToText(stickerGifStatus)}`, callback_data: statusToCallback('enable_sticker_forwarding', stickerGifStatus) }],
            // 现有的过滤类型
            [{ text: `图片/视频/文件 (Photo/Video/Doc): ${statusToText(mediaStatus)}`, callback_data: statusToCallback('enable_image_forwarding', mediaStatus) }],
            [{ text: `频道转发消息 (Channel Forward): ${statusToText(channelForwardStatus)}`, callback_data: statusToCallback('enable_channel_forwarding', channelForwardStatus) }],
            [{ text: `链接消息 (URL/TextLink): ${statusToText(linkStatus)}`, callback_data: statusToCallback('enable_link_forwarding', linkStatus) }],
            [{ text: `纯文本消息 (Pure Text): ${statusToText(textStatus)}`, callback_data: statusToCallback('enable_text_forwarding', textStatus) }],
            [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
        ]
    };
  
    const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
    const params = {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
    };
    if (apiMethod === "editMessageText") {
        params.message_id = messageId;
    }
    await telegramApi(env.BOT_TOKEN, apiMethod, params);
  }
  
  async function handleAdminConfigInput(userId, text, adminStateJson, env) {
    const adminState = JSON.parse(adminStateJson);
  
    if (text.toLowerCase() === "/cancel") {
        // 删除状态
        await dbAdminStateDelete(userId, env);
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: userId,
            text: "✅ 编辑已取消。",
        });
        await handleAdminConfigStart(userId, env);
        return;
    }
  
    if (adminState.action === 'awaiting_input' && adminState.key) {
        let successMsg = "";
        let finalValue = text;
  
        if (adminState.key === 'verif_a' || adminState.key === 'block_threshold') {
            finalValue = text.trim(); 
            successMsg = `✅ ${adminState.key} 已更新为 <code>${escapeHtml(finalValue)}</code>。`;
        } else if (adminState.key === 'backup_group_id') {
            finalValue = text.trim(); 
            successMsg = `✅ 备份群组 ID 已更新为 <code>${escapeHtml(finalValue)}</code>。`;
        } else if (adminState.key === 'authorized_admins') {
            // 将输入字符串按逗号分隔，并清洗 ID/用户名列表
            const rawAdmins = text.split(',').map(id => id.trim()).filter(id => id !== "");
            // 移除潜在的 @ 前缀 (虽然 ID 也可以)
            const cleanAdmins = rawAdmins.map(id => id.startsWith('@') ? id.substring(1) : id); 
            finalValue = JSON.stringify(cleanAdmins);
            successMsg = `✅ 授权协管员列表已更新。共 <b>${cleanAdmins.length}</b> 人。`;
  
        } else if (adminState.key === 'keyword_responses') {
            // 新增自动回复规则：格式为 "关键词表达式 | 回复内容"
            const parts = text.split('|');
            if (parts.length < 2) {
                await telegramApi(env.BOT_TOKEN, "sendMessage", {
                    chat_id: userId,
                    text: "❌ 格式错误！请使用： <code>关键词表达式 | 回复内容</code>",
                    parse_mode: "HTML",
                });
                return;
            }
            const keywords = parts[0].trim();
            const response = parts.slice(1).join('|').trim(); // 允许回复内容中包含 |
            
            if (!keywords || !response) {
                 await telegramApi(env.BOT_TOKEN, "sendMessage", {
                    chat_id: userId,
                    text: "❌ 关键词或回复内容不能为空。",
                    parse_mode: "HTML",
                });
                return;
            }
  
            const rules = await getAutoReplyRules(env);
            rules.push({ keywords, response, id: Date.now() }); // 使用时间戳作为唯一ID
            finalValue = JSON.stringify(rules);
            successMsg = `✅ 自动回复规则已新增： <code>${escapeHtml(keywords.substring(0, 15))}...</code>`;
            
            // 更新配置
            await dbConfigPut(adminState.key, finalValue, env);
            // 成功后清除状态
            await dbAdminStateDelete(userId, env);
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: successMsg, parse_mode: "HTML" });
            await handleAdminAutoReplyMenu(userId, adminState.message_id, env); // 返回列表
            return;
  
        } else if (adminState.key === 'block_keywords') {
            // 新增屏蔽关键词：直接添加
            const newKeyword = text.trim();
            if (!newKeyword) {
                 await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "❌ 关键词不能为空。", });
                 return;
            }
            const keywords = await getBlockKeywords(env);
            if (keywords.includes(newKeyword)) {
                 await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: `⚠️ 关键词 <code>${escapeHtml(newKeyword)}</code> 已存在。`, parse_mode: "HTML" });
                 return;
            }
            keywords.push(newKeyword); 
            finalValue = JSON.stringify(keywords);
            successMsg = `✅ 屏蔽关键词已新增： <code>${escapeHtml(newKeyword)}</code>`;
  
            // 更新配置
            await dbConfigPut(adminState.key, finalValue, env);
            // 成功后清除状态
            await dbAdminStateDelete(userId, env);
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: successMsg, parse_mode: "HTML" });
            await handleAdminKeywordBlockMenu(userId, adminState.message_id, env); // 返回列表
            return;
  
        } else {
            // 其他简单文本配置
            successMsg = `✅ ${adminState.key} 已更新。`;
        }
        
        // 更新配置
        await dbConfigPut(adminState.key, finalValue, env);
  
        // 成功后清除状态
        await dbAdminStateDelete(userId, env);
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: successMsg, parse_mode: "HTML" });
        
        // 返回到父级菜单
        const parentMenu = adminState.parent_menu || "config:menu";
        await handleAdminConfigCallback(userId, adminState.message_id, parentMenu, env);
  
    } else {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: userId,
            text: "⚠️ 机器人当前未处于配置输入状态。请使用 /start 重新进入主菜单。",
        });
    }
  }
  
  async function handleAdminConfigCallback(chatId, messageId, callbackData, env) {
    const isPrimary = isPrimaryAdmin(chatId, env);
    if (!isPrimary) return; 
  
    // 确保清除旧状态
    await dbAdminStateDelete(chatId, env);
  
    const parts = callbackData.split(':');
    const actionType = parts[1]; // menu, edit, toggle, list, add, delete
  
    if (actionType === 'menu') {
        const menu = parts[2] || 'main';
        if (menu === 'main') {
            await handleAdminConfigStart(chatId, env, messageId);
        } else if (menu === 'base') {
            await handleAdminBaseConfigMenu(chatId, messageId, env);
        } else if (menu === 'autoreply') {
            await handleAdminAutoReplyMenu(chatId, messageId, env);
        } else if (menu === 'keyword') {
            await handleAdminKeywordBlockMenu(chatId, messageId, env);
        } else if (menu === 'filter') {
            await handleAdminTypeBlockMenu(chatId, messageId, env);
        } else if (menu === 'authorized') {
            await handleAdminAuthorizedConfigMenu(chatId, messageId, env);
        } else if (menu === 'backup') {
            await handleAdminBackupConfigMenu(chatId, messageId, env);
        }
    } else if (actionType === 'edit' || actionType === 'add') {
        const key = parts[2];
        let prompt = "";
        let parentMenu = `config:menu:${key.includes('keyword') || key.includes('responses') ? 'autoreply' : (key.includes('block') || key.includes('threshold') ? 'keyword' : (key.includes('authorized') ? 'authorized' : (key.includes('backup') ? 'backup' : 'base')))}`;
        
        if (key === 'welcome_msg') prompt = "请输入新的欢迎消息：";
        else if (key === 'verif_q') prompt = "请输入新的验证问题：";
        else if (key === 'verif_a') prompt = "请输入新的验证答案（支持多个验证答案，多个答案中请用|分隔。）：";
        else if (key === 'block_threshold') prompt = "请输入新的屏蔽次数阈值（纯数字）：";
        else if (key === 'backup_group_id') prompt = "请输入备份群组的 ID 或 @用户名：";
        else if (key === 'authorized_admins') prompt = "请输入新的协管员 ID 或 @用户名（多个用逗号分隔）：";
        else if (key === 'keyword_responses') prompt = "请输入新的自动回复规则，格式为：\n`关键词表达式 | 回复内容`\n（关键词支持正则表达式，但请谨慎使用）";
        else if (key === 'block_keywords') prompt = "请输入新的屏蔽关键词（支持正则表达式，但请谨慎使用）：";
        else if (key.endsWith('_clear')) { // 清除操作
            if (key === 'authorized_admins_clear') {
                await dbConfigPut('authorized_admins', '[]', env);
                parentMenu = 'config:menu:authorized';
                await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: parts[0], text: "✅ 协管员列表已清空。", show_alert: false });
            } else if (key === 'backup_group_id_clear') {
                await dbConfigPut('backup_group_id', '', env); // 清空即禁用
                parentMenu = 'config:menu:backup';
                await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: parts[0], text: "✅ 备份群组已禁用。", show_alert: false });
            }
            await handleAdminConfigCallback(chatId, messageId, parentMenu, env);
            return;
        }
  
        const state = { action: 'awaiting_input', key: key, message_id: messageId, parent_menu: parentMenu };
        await dbAdminStatePut(chatId, JSON.stringify(state), env);
        
        await telegramApi(env.BOT_TOKEN, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: `${prompt}\n\n请直接回复本消息。\n输入 /cancel 取消。`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "⬅️ 取消编辑并返回", callback_data: parentMenu }]] }
        });
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: parts[0], text: "请回复新的内容。", show_alert: false });
    } else if (actionType === 'toggle') {
        const key = parts[2];
        const newValue = parts[3]; // 'true' or 'false'
        await dbConfigPut(key, newValue, env);
        
        const statusText = newValue === 'true' ? '已允许' : '已屏蔽';
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: parts[0], text: `✅ ${key} 状态已切换为 ${statusText}`, show_alert: false });
        
        // 刷新列表
        await handleAdminTypeBlockMenu(chatId, messageId, env);
  
    } else if (actionType === 'list') {
        const key = parts[2];
        await handleAdminRuleList(chatId, messageId, env, key);
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: parts[0], text: "规则列表已刷新。", show_alert: false });
  
    } else if (actionType === 'delete') {
        const key = parts[2];
        const id = parts[3];
        // BUG FIX: 传递正确的 callbackQueryId
        await handleAdminRuleDelete(chatId, messageId, parts[0], env, key, id);
        // handleAdminRuleDelete 内部已经处理了 answerCallbackQuery 和刷新列表
    }
  }
  
  async function handleCallbackQuery(callbackQuery, env) {
    const callbackData = callbackQuery.data;
    const chatId = callbackQuery.from.id.toString();
    const messageId = callbackQuery.message?.message_id;
    const isPrimary = isPrimaryAdmin(chatId, env);
  
    if (callbackData.startsWith('config:') && isPrimary) {
        // 管理员配置逻辑
        await handleAdminConfigCallback(chatId, messageId, callbackData, env);
    } else if (callbackData.startsWith('block:') || callbackData.startsWith('unblock:')) {
        // 屏蔽/解禁用户
        const parts = callbackData.split(':');
        const action = parts[0];
        const userIdToModify = parts[1];
        const isBlocked = action === 'block';
  
        await dbUserUpdate(userIdToModify, { is_blocked: isBlocked, block_count: 0 }, env); // 屏蔽时重置计数
  
        const resultText = isBlocked ? "🚫 用户已被屏蔽。机器人将不再转发此人的消息。" : "✅ 用户已解除屏蔽。";
        
        // 更新按钮
        const user = await dbUserGetOrCreate(userIdToModify, env);
        const newButtons = getInfoCardButtons(userIdToModify, isBlocked);
  
        await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
            chat_id: callbackQuery.message.chat.id,
            message_id: messageId,
            reply_markup: newButtons,
        }).catch(e => console.error("Failed to edit message reply markup:", e.message));
  
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
            callback_query_id: callbackQuery.id,
            text: resultText,
            show_alert: true,
        });
  
    } else if (callbackData.startsWith('pin_card:')) {
        // 置顶消息
        try {
            await telegramApi(env.BOT_TOKEN, "pinChatMessage", {
                chat_id: callbackQuery.message.chat.id,
                message_id: messageId,
                disable_notification: true
            });
            await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
                callback_query_id: callbackQuery.id,
                text: "✅ 资料卡已置顶。",
                show_alert: false,
            });
        } catch (e) {
            console.error("Failed to pin message:", e);
            await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
                callback_query_id: callbackQuery.id,
                text: "❌ 置顶失败。请确认机器人是否有置顶权限。",
                show_alert: true,
            });
        }
    } else {
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
            callback_query_id: callbackQuery.id,
            text: "操作已完成或无权限。",
            show_alert: false,
        });
    }
  }
  
  
  // --- 消息中继和话题管理 ---
  
  /**
   * 核心功能：用户私聊 -> 管理员群组话题
   */
  async function handleRelayToTopic(message, user, env) {
    const chatId = message.chat.id.toString();
    const fromUser = message.from;
  
    let topicId = user.topic_id; 
    let userInfoCard = user.user_info; // 从 D1 获取存储的资料卡
  
    // 1. 如果没有 topic_id，创建新话题
    if (!topicId) {
        const { topicName, infoCard } = getUserInfo(fromUser, message.date);
        
        try {
            // 1.1. 创建话题
            const topicResult = await telegramApi(env.BOT_TOKEN, "createForumTopic", {
                chat_id: env.ADMIN_GROUP_ID,
                name: topicName,
            });
            topicId = topicResult.message_thread_id.toString();
            
            // 1.2. 更新 D1 记录
            await dbUserUpdate(chatId, { topic_id: topicId, user_info: { infoCard, messageId: null, timestamp: message.date } }, env);
            
            // 1.3. 发送资料卡到话题，并置顶
            const cardMessage = await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: env.ADMIN_GROUP_ID,
                text: infoCard,
                parse_mode: "HTML",
                message_thread_id: topicId,
                reply_markup: getInfoCardButtons(chatId, false) // 初始非屏蔽状态
            });
            
            // 1.4. 更新 D1 存储资料卡消息ID
            await dbUserUpdate(chatId, { user_info: { infoCard, messageId: cardMessage.message_id, timestamp: message.date } }, env);
  
            // 1.5. 置顶资料卡
            await telegramApi(env.BOT_TOKEN, "pinChatMessage", {
                chat_id: env.ADMIN_GROUP_ID,
                message_id: cardMessage.message_id,
                disable_notification: true
            });
  
        } catch (e) {
            const errorMessage = `❌ 转发失败！创建话题或发送资料卡出错：${e.message}`;
            console.error(errorMessage);
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: errorMessage });
            return;
        }
    } else {
        // 2. 如果话题已存在，检查话题名称是否需要更新（例如，用户名/昵称变更）
        if (userInfoCard && message.date > userInfoCard.timestamp) {
            const { topicName, infoCard, userId } = getUserInfo(fromUser, userInfoCard.timestamp);
            
            // 只有名称不同才更新
            if (topicName !== user.topic_id_name) {
                try {
                    await telegramApi(env.BOT_TOKEN, "setForumTopicTitle", {
                        chat_id: env.ADMIN_GROUP_ID,
                        message_thread_id: topicId,
                        title: topicName
                    });
                } catch (e) {
                    // 忽略 setForumTopicTitle 失败 (可能是权限不足)
                    // console.log("Failed to update topic title:", e.message);
                }
            }
            
            // 检查是否需要更新资料卡消息
            if (userInfoCard.messageId) {
                try {
                    // 重新发送资料卡，并更新 D1 存储
                    await telegramApi(env.BOT_TOKEN, "editMessageText", {
                        chat_id: env.ADMIN_GROUP_ID,
                        message_id: userInfoCard.messageId,
                        text: infoCard,
                        parse_mode: "HTML",
                        reply_markup: getInfoCardButtons(userId, user.is_blocked) 
                    });
                } catch (e) {
                    // 忽略编辑失败
                }
            }
            
            // 更新 user_info_json 中的时间戳
            await dbUserUpdate(chatId, { user_info: { ...userInfoCard, timestamp: message.date } }, env);
        }
    }
  
    // 3. 转发用户消息到话题
    try {
        const copyParams = {
            chat_id: env.ADMIN_GROUP_ID,
            from_chat_id: chatId,
            message_id: message.message_id,
            message_thread_id: topicId,
        };
  
        // 备份群组（可选）
        const backupGroupId = await getConfig('backup_group_id', env, "");
        if (backupGroupId) {
            try {
                const backupParams = { ...copyParams, chat_id: backupGroupId };
                delete backupParams.message_thread_id; // 备份群组通常是普通群组，没有话题ID
                await telegramApi(env.BOT_TOKEN, "copyMessage", backupParams);
            } catch(e) {
                // 备份失败不影响主流程
                console.error("Failed to copy message to backup group:", e.message);
            }
        }
        
        const topicMessage = await telegramApi(env.BOT_TOKEN, "copyMessage", copyParams);
        
        // 存储消息映射关系 (用于处理已编辑消息 - User -> Admin)
        await dbMessageDataPut(chatId, message.message_id.toString(), { 
            text: message.text || message.caption || "[媒体内容]", 
            date: message.date 
        }, env);
  
    } catch (e) {
        const errorMessage = `❌ 转发失败！请联系管理员。错误详情：${e.message}`;
        console.error(errorMessage);
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: errorMessage });
    }
  }
  
  /**
   * 核心功能：管理员回复话题 -> 用户私聊
   * [修改]：新增逻辑，存储管理员的回复消息内容和时间，用于后续编辑跟踪。
   */
  async function handleAdminReply(message, env) {
    // 1. 确保是话题内的消息
    if (!message.is_topic_message || !message.message_thread_id) return;
  
    // 2. 检查是否来自管理员群组
    const adminGroupIdStr = env.ADMIN_GROUP_ID.toString();
    if (message.chat.id.toString() !== adminGroupIdStr) return;
  
    // 3. 忽略机器人自己的消息
    if (message.from && message.from.is_bot) return;
  
    // 4. 检查消息发送者是否是授权协管员或主管理员
    const senderId = message.from.id.toString();
    const isAuthorizedAdmin = await isAdminUser(senderId, env);
    
    if (!isAuthorizedAdmin) {
        // 只有管理员的回复才转发
        return; 
    }
  
    // 5. 根据话题ID查找用户ID
    const topicId = message.message_thread_id.toString();
    const userId = await dbTopicUserGet(topicId, env);
  
    if (!userId) {
        // 如果找不到用户ID，说明此话题不是由机器人创建或已被清除
        try {
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: message.chat.id,
                text: "⚠️ 警告：无法找到此话题对应的用户ID，回复未转发。",
                message_thread_id: topicId,
            });
        } catch (e) { /* ignore */ }
        return;
    }
  
    // 6. 转发消息给用户
    try {
        // 尝试使用 copyMessage 转发，保留格式和媒体
        await telegramApi(env.BOT_TOKEN, "copyMessage", {
            chat_id: userId,
            from_chat_id: message.chat.id,
            message_id: message.message_id,
        });
  
        // 7. [新增] 存储消息映射关系 (用于处理已编辑消息 - Admin -> User)
        // 使用 user_id (私聊ID) + message.message_id (管理员群组消息ID) 作为键
        await dbMessageDataPut(userId, message.message_id.toString(), { 
            text: message.text || message.caption || "[媒体内容]", 
            date: message.date 
        }, env);
  
    } catch (e) {
        // 7. 如果 copyMessage 失败 (通常是因为回复了机器人无法直接转发的内容，如服务消息或某些特殊媒体)
        // 尝试降级处理，只发送文本/媒体文件（复制）
        console.error("handleAdminReply copyMessage failed, attempting fallback:", e?.message || e);
  
        try {
            // 在降级成功的情况下，也需要存储消息内容
            const textContent = message.text || message.caption || "[媒体内容]";
            let success = false;
            
            if (message.text) {
                await telegramApi(env.BOT_TOKEN, "sendMessage", {
                    chat_id: userId,
                    text: message.text,
                    parse_mode: "HTML", // 保持解析模式
                });
                success = true;
            } else if (message.photo) {
                // 发送最高分辨率的图片
                const largestPhoto = message.photo.pop();
                await telegramApi(env.BOT_TOKEN, "sendPhoto", {
                    chat_id: userId,
                    photo: largestPhoto.file_id,
                    caption: message.caption || "",
                });
                success = true;
            } else if (message.video) {
                await telegramApi(env.BOT_TOKEN, "sendVideo", {
                    chat_id: userId,
                    video: message.video.file_id,
                    caption: message.caption || "",
                });
                success = true;
            } else if (message.audio) {
                await telegramApi(env.BOT_TOKEN, "sendAudio", {
                    chat_id: userId,
                    audio: message.audio.file_id,
                    caption: message.caption || "",
                });
                success = true;
            } else if (message.voice) {
                await telegramApi(env.BOT_TOKEN, "sendVoice", {
                    chat_id: userId,
                    voice: message.voice.file_id,
                    caption: message.caption || "",
                });
                success = true;
            } else if (message.sticker) {
                await telegramApi(env.BOT_TOKEN, "sendSticker", {
                    chat_id: userId,
                    sticker: message.sticker.file_id,
                });
                success = true;
            } else if (message.animation) {
                await telegramApi(env.BOT_TOKEN, "sendAnimation", {
                    chat_id: userId,
                    animation: message.animation.file_id,
                    caption: message.caption || "",
                });
                success = true;
            } else {
                await telegramApi(env.BOT_TOKEN, "sendMessage", {
                    chat_id: userId,
                    text: "管理员发送了机器人无法直接转发的内容（例如投票或某些特殊媒体）。",
                });
                success = true; // 即使是警告消息，也视为成功发送
            }
  
            if (success) {
                 // 存储消息映射关系 (用于处理已编辑消息 - Admin -> User)
                await dbMessageDataPut(userId, message.message_id.toString(), { 
                    text: textContent, 
                    date: message.date 
                }, env);
            }
  
        } catch (e2) {
            console.error("handleAdminReply fallback also failed:", e2?.message || e2);
        }
    }
  }
  
  /**
   * 用户编辑消息 -> 管理员话题编辑
   */
  async function handleRelayEditedMessage(editedMessage, env) {
    const userId = editedMessage.chat.id.toString();
    const messageId = editedMessage.message_id.toString();
    
    // 1. 确保用户是已验证状态（已在 handlePrivateMessage 中处理，此处只进行二次确认）
    const user = await dbUserGetOrCreate(userId, env);
    if (user.user_state !== "verified" || !user.topic_id) return;
    
    // 2. 从消息表中查找原始消息的文本和发送日期（已在 handleRelayToTopic 中存储）
    const storedMessage = await dbMessageDataGet(userId, messageId, env);
    if (!storedMessage) return; // 找不到原始消息，无法编辑
  
    const newText = editedMessage.text || editedMessage.caption || "[媒体内容]";
    
    // 3. 格式化时间
    // storedMessage.date 存储的是原发送时间或上次编辑后的时间
    const originalTime = formatTimestamp(storedMessage.date); 
    // editedMessage.edit_date 是本次编辑的时间
    const editTime = formatTimestamp(editedMessage.edit_date || editedMessage.date); 
    
    // 4. 通知管理员
    const notificationText = `
  ⚠️ <b>用户编辑了消息</b>
  ---
  <b>原发送/上次编辑时间:</b> <code>${originalTime}</code>
  <b>本次编辑时间:</b> <code>${editTime}</code>
  ---
  <b>原消息内容：</b>
  ${escapeHtml(storedMessage.text)}
  ---
  <b>新消息内容：</b>
  ${escapeHtml(newText)}
    `.trim();
  
    try {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.ADMIN_GROUP_ID,
            text: notificationText,
            parse_mode: "HTML",
            message_thread_id: user.topic_id,
        });
        
        // 5. 更新消息表中的存储内容 (用于下次编辑时作为"原消息")
        await dbMessageDataPut(userId, messageId, { text: newText, date: editedMessage.edit_date || editedMessage.date }, env);
  
    } catch (e) {
        console.error("Failed to notify admin about edited message:", e.message);
    }
  }
