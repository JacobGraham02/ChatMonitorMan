const { SlashCommandBuilder } = require('@discordjs/builders');
module.exports = function (player_steam_id) {
    const object = {
        data: new SlashCommandBuilder()
            .setName('drill')
            .setDescription('Spawns a drill'),
        command_data: [`#TeleportTo ${player_steam_id.user_steam_id}`, '#SpawnItem Drill', `#Teleport 0 0 0`],
        authorization_role_name: [],
        command_cost: 500,

        async execute(interaction) {

        }
    }
    return object;
}