const { SlashCommandBuilder } = require('@discordjs/builders');
module.exports = function (player_steam_id) {
    const object = {
        data: new SlashCommandBuilder()
            .setName('ammo762x54r')
            .setDescription('Spawns 3 boxes of 7.62x54r armour piercing ammo boxes'),
        command_data: [`#TeleportTo ${player_steam_id.user_steam_id}`, '#SpawnItem Cal_7_62x54mmR_Ammobox 3', `#Teleport 0 0 0`],
        authorization_role_name: [],
        command_cost: 2000,

        async execute(interaction) {

        }
    }
    return object;
}