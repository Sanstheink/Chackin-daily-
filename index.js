const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DATABASE_URL = process.env.DATABASE_URL;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// PostgreSQL connection
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false } // ปลอดภัยกับ external DB
});

// สร้างตาราง users ถ้ายังไม่มี
pool.query(`
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    last_checkin TIMESTAMP,
    points INT DEFAULT 0
)
`).then(() => console.log('Users table ready'))
  .catch(console.error);

// สร้างคำสั่ง slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('checkin')
        .setDescription('เช็คอินรายวันและรับแต้ม')
        .toJSON(),
    new SlashCommandBuilder()
        .setName('points')
        .setDescription('เช็คแต้มสะสมของคุณหรือของคนอื่น')
        .addUserOption(option => option.setName('user').setDescription('เลือกผู้ใช้'))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('addpoints')
        .setDescription('เพิ่มแต้มให้ผู้ใช้ (Admin เท่านั้น)')
        .addUserOption(option => option.setName('user').setDescription('ผู้ใช้ที่ต้องการเพิ่มแต้ม').setRequired(true))
        .addIntegerOption(option => option.setName('amount').setDescription('จำนวนแต้มที่เพิ่ม').setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('removepoints')
        .setDescription('ลดแต้มผู้ใช้ (Admin เท่านั้น)')
        .addUserOption(option => option.setName('user').setDescription('ผู้ใช้ที่ต้องการลดแต้ม').setRequired(true))
        .addIntegerOption(option => option.setName('amount').setDescription('จำนวนแต้มที่ลด').setRequired(true))
        .toJSON()
];

// register commands
const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('Registering slash commands...');
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );
        console.log('Slash commands registered');
    } catch (err) {
        console.error(err);
    }
})();

// ฟังก์ชันตรวจสอบวัน
function isSameDay(date1, date2) {
    return date1.getFullYear() === date2.getFullYear() &&
           date1.getMonth() === date2.getMonth() &&
           date1.getDate() === date2.getDate();
}

// ฟังก์ชันตรวจสอบสิทธิ์ admin
async function isAdmin(interaction) {
    if (!interaction.member.permissions.has('Administrator')) {
        await interaction.reply({ content: 'คุณไม่มีสิทธิ์ใช้คำสั่งนี้', ephemeral: true });
        return false;
    }
    return true;
}

// ready event
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

// interactionCreate event
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const userId = interaction.user.id;
    const today = new Date();

    // /checkin
    if (interaction.commandName === 'checkin') {
        try {
            const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
            const row = res.rows[0];

            if (row && isSameDay(new Date(row.last_checkin), today)) {
                await interaction.reply({ content: 'คุณเช็คอินวันนี้แล้ว!', ephemeral: true });
            } else {
                const pointsToAdd = 10;
                if (row) {
                    await pool.query(
                        'UPDATE users SET last_checkin = $1, points = points + $2 WHERE user_id = $3',
                        [today, pointsToAdd, userId]
                    );
                } else {
                    await pool.query(
                        'INSERT INTO users(user_id, last_checkin, points) VALUES($1, $2, $3)',
                        [userId, today, pointsToAdd]
                    );
                }
                await interaction.reply({ content: `เช็คอินสำเร็จ! รับ ${pointsToAdd} แต้ม`, ephemeral: true });
            }
        } catch (err) {
            console.error(err);
            await interaction.reply({ content: 'เกิดข้อผิดพลาด กรุณาลองอีกครั้ง', ephemeral: true });
        }
    }

    // /points
    else if (interaction.commandName === 'points') {
        const targetUser = interaction.options.getUser('user') || interaction.user;
        try {
            const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [targetUser.id]);
            const row = res.rows[0];
            if (!row) {
                await interaction.reply({ content: `${targetUser.username} ยังไม่มีแต้ม`, ephemeral: true });
            } else {
                await interaction.reply({ content: `${targetUser.username} มี ${row.points} แต้ม`, ephemeral: true });
            }
        } catch (err) {
            console.error(err);
            await interaction.reply({ content: 'เกิดข้อผิดพลาด กรุณาลองอีกครั้ง', ephemeral: true });
        }
    }

    // /addpoints (Admin)
    else if (interaction.commandName === 'addpoints') {
        if (!await isAdmin(interaction)) return;

        const targetUser = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');

        try {
            const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [targetUser.id]);
            if (res.rows[0]) {
                await pool.query('UPDATE users SET points = points + $1 WHERE user_id = $2', [amount, targetUser.id]);
            } else {
                await pool.query('INSERT INTO users(user_id, last_checkin, points) VALUES($1, $2, $3)', [targetUser.id, null, amount]);
            }
            await interaction.reply({ content: `เพิ่ม ${amount} แต้มให้ ${targetUser.username} เรียบร้อยแล้ว`, ephemeral: true });
        } catch (err) {
            console.error(err);
            await interaction.reply({ content: 'เกิดข้อผิดพลาด', ephemeral: true });
        }
    }

    // /removepoints (Admin)
    else if (interaction.commandName === 'removepoints') {
        if (!await isAdmin(interaction)) return;

        const targetUser = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');

        try {
            const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [targetUser.id]);
            if (!res.rows[0]) {
                await interaction.reply({ content: `${targetUser.username} ยังไม่มีแต้ม`, ephemeral: true });
                return;
            }

            let newPoints = res.rows[0].points - amount;
            if (newPoints < 0) newPoints = 0;

            await pool.query('UPDATE users SET points = $1 WHERE user_id = $2', [newPoints, targetUser.id]);
            await interaction.reply({ content: `ลด ${amount} แต้มของ ${targetUser.username} เรียบร้อยแล้ว`, ephemeral: true });
        } catch (err) {
            console.error(err);
            await interaction.reply({ content: 'เกิดข้อผิดพลาด', ephemeral: true });
        }
    }
});

// login bot
client.login(TOKEN);
