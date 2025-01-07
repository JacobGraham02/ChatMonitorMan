import {Router} from 'express';
import {validatePassword} from '../modules/hashAndValidatePassword.js';
import Logger from '../utils/Logger.js';
import Cache from '../utils/Cache.js';
import {body, validationResult} from 'express-validator';
import BotRepository from '../database/MongoDb/BotRepository.js';

var router = Router();
const logger = new Logger();
const cache = new Cache();

function isLoggedIn(request, response, next) {
    if (request.isAuthenticated()) {
        return next();
    } else {
        response.redirect('/login');
    }
}

function checkBotRepositoryInCache(request, response, next) {
    const guildId = request.user.guild_id;
    const cacheKey = `bot_repository_${guildId}`;

    if (!cache.get(cacheKey)) {
        const botRepository = new BotRepository(guildId);
        cache.set(cacheKey, botRepository);
    }
    request.user.bot_repository = cache.get(cacheKey);
    next();
}

router.post('/logdata', async function(request, response) {
    const { log_type, message, guild_id, file_type } = request.body;

    try {
        await logger.writeLogToAzureContainer(
            `${log_type}`,
            `${message}`,
            `${guild_id}`,
            `${guild_id}-${file_type}`
        );
        response.status(200).json({ success: true, message: `The log data has been written to the specified log file successfully`});
    } catch (error) {
        response.status(500).json({ success: false, message: `Failed to write data to the specified log file: ${error}`});
    }
});

router.post('/createwebsocket',
    body('email')
    .isEmail()
    .withMessage(`Please enter a valid email address`),

    body('password')
    .isLength({ min: 1, max: 32})
    .trim()
    .withMessage(`The password field cannot be empty`),

    async function(request, response) {

        const errors = validationResult(request);
        if (!errors.isEmpty()) {
            request.session.alert_title = 'Validation errors';
            request.session.alert_description = '<ul id="error_message_list">' + errors.array().map(error => `<li>${error.msg}</li>`).join('') + '</ul>';
            request.session.show_error_modal = true;
            return response.redirect('/login');
        }

        const { email, password } = request.body;
        const botRepository = new BotRepository();

        try {
            const repository_user = await botRepository.getBotDataByEmail(email);

            if (repository_user) {
                const user_password = repository_user.bot_password;
                const user_salt = repository_user.bot_salt;
                const is_valid_account = validatePassword(password, user_password, user_salt);

                if (is_valid_account) {
                    const user_id = repository_user.guild_id;
                    return response.json({ success: true, message: `Login successful`, bot_id: user_id});
                } else {
                    return response.status(401).json({ success: false, message: `Invalid credentials` });
                }
            } else {
                return response.status(401).json({ success: false, message: `Invalid credentials` });
            }
        } catch (error) {
            console.log("Error during login");
            console.log(error);
            return response.status(500).json({success: false, message: "An error occurred during login", error: `${error}`});
        }
});

router.get('/newteleportcommand', isLoggedIn, function(request, response) {
    try {
        response.render('admin/new_teleport_command', {
            user: request.user,
            currentPage: '/admin/teleport_command_list',
            title: `New teleport command`,
            submit_modal_title: `Create new teleport area`,
            submit_modal_description: `Are you sure you want to create this new teleport command?`,
            cancel_modal_title: `Go back`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`
        });
    } catch (error) {
        console.error(`There was an error when attempting to load the admin new command page. Please inform the server administrator of this error or try again: ${error}`);
        response.render('admin/new_teleport_command', {
            user: request.user,
            currentPage: '/admin/teleport_command_list',
            title: `New teleport command`,
            submit_modal_title: `Create item package`,
            submit_modal_description: `Are you sure you want to create this new teleport command?`,
            cancel_modal_title: `Go back`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`
        });
    }
});

router.get('/newcommand', isLoggedIn, function(request, response) {
    try {
        response.render('admin/new_command', {
            user: request.user,
            currentPage: '/admin/command_list',
            title: `New item package`,
            submit_modal_title: `Create item package`,
            submit_modal_description: `Are you sure you want to create this item package?`,
            cancel_modal_title: `Go back`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`
        });
    } catch (error) {
        console.error(`There was an error when attempting to load the admin new command page. Please inform the server administrator of this error or try again: ${error}`);
        response.render('admin/new_command', {
            user: request.user,
            currentPage: '/admin/command_list',
            title: `New item package`,
            submit_modal_title: `Create item package`,
            submit_modal_description: `Are you sure you want to create this item package?`,
            cancel_modal_title: `Go back`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`
        });
    }
});

router.get('/command/:commandname', isLoggedIn, checkBotRepositoryInCache, async (request, response) => {
    const package_name = request.params.commandname;
    const botRepository = request.user.bot_repository;

    try {
        const package_data = await botRepository.getBotPackageFromName(package_name);

        response.render('admin/command', {
            user: request.user,
            package: package_data,
            title: `${package_name}`,
            currentPage: '/admin/command_list',
            submit_modal_title: `Change command`,
            submit_modal_description: `Are you sure you want to change this command?`,
            cancel_modal_title: `Go back`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`
        });

    } catch (error) {
        console.error(`Error fetching command data: ${error}`);
        response.render('admin/command', {
            user: request.user,
            title: `${package_name}`
        });
    }
});

router.get('/teleportcommand/:commandname', isLoggedIn, checkBotRepositoryInCache, async (request, response) => {
    const teleport_command_name = request.params.commandname;
    const botRepository = request.user.bot_repository;

    try {
        const teleport_command_data = await botRepository.getBotTeleportCommandFromName(teleport_command_name);
        response.render('admin/teleport_command', {
            user: request.user,
            teleport_command: teleport_command_data,
            title: `${teleport_command_name}`,
            currentPage: `/admin/teleport_command_list`,
            submit_modal_title: `Change teleport command`,
            submit_modal_description: `Are you sure you want to change this teleport command?`,
            cancel_modal_title: `Go back`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`
        });
    } catch (error) {
        response.render('admin/teleport_command', {
            user:request.user,
            title: `${teleport_command_name}`
        });
    }
});


router.get(['/login-success'], isLoggedIn, function(request, response) {
    try {
        response.render('admin/index', {
            user: request.user,
            currentPage: '/admin/',
            title: `Admin dashboard`,
            show_submit_modal: true,
            alert_title: `Success`,
            alert_description: `You successfully logged in to your account`
        });
    } catch (error) {
        response.render('admin/index', {
            user: request.user,
            currentPage: '/admin/',
            title: `Admin dashboard`,
            show_error_modal: true,
            alert_title: `Error when logging in`,
            alert_description: `There was an error when attempting to load the admin index file after logging in. Please inform the server administrator of this error or try again: ${error}`
        });
    }
});

router.get('/', isLoggedIn, function(request, response) {
    response.render('admin/index', {
        user: request.user,
        currentPage: '/admin/',
        title: `Admin dashboard`,
    });
});

router.get(['/commands'], isLoggedIn, checkBotRepositoryInCache, async (request, response) => {
    let bot_packages;
    const botRepository = request.user.bot_repository;
    const commands_deleted_count = request.query.deleted;
    const operation_success = request.query.success;

    try {
        bot_packages = await botRepository.getBotItemPackagesData();
    } catch (error) {
        console.error(`There was an internal service error when attempting to read all the command data from MongoDB: ${error}`);
        response.status(500).json({ error: `There was an internal service error when attempting to read all the command data from MongoDB: ${error}` });
        return; // Make sure to return after sending the response
    }

    if (bot_packages) {
        const commands_per_page = 10;

        // Sort the commands
        bot_packages.sort((a, b) => a.package_name.localeCompare(b.package_name));

        // Parse the 'range' query parameter
        const range = request.query.range || '1&10';
        const [start_range_number, end_range_number] = range.split('&').map(Number);

        // Calculate pagination variables
        const current_page_number = Math.ceil(start_range_number / commands_per_page);
        const total_number_of_pages = Math.ceil(bot_packages.length / commands_per_page);

        const visible_pages = 3;
        let start_page = Math.max(1, current_page_number - Math.floor(visible_pages / 2));
        let end_page = Math.min(total_number_of_pages, start_page + visible_pages - 1);
        start_page = Math.max(1, end_page - visible_pages + 1);
        const page_numbers = Array.from({ length: end_page - start_page + 1 }, (_, i) => i + start_page);

        // Slice the commands for the current page
        const current_page_packages = bot_packages.slice(start_range_number - 1, end_range_number);

        // Prepare variables for the template
        const current_page_commands = current_page_packages;
        const server_commands = bot_packages; // All commands for search functionality
        const total_command_files = bot_packages.length;
        const current_page_of_commands = current_page_number;

        if (typeof operation_success === 'undefined') {
            response.render('admin/command_list', {
                title: 'Commands',
                current_page_commands,
                server_commands,
                current_page_of_commands,
                total_command_files,
                total_number_of_pages,
                page_numbers,
                user: request.user,
                currentPage: '/admin/command_list',
                submit_modal_title: `Delete command`,
                submit_modal_description: `Are you sure you want to delete the selected commands? If they are deleted, they can no longer be used`,
                cancel_modal_title: `Go to the previous page`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`
            });
        } else if (operation_success === 'true') {
            response.render('admin/command_list', {
                title: 'Commands',
                current_page_commands,
                server_commands,
                current_page_of_commands,
                total_command_files,
                total_number_of_pages,
                page_numbers,
                user: request.user,
                currentPage: '/admin/command_list',
                submit_modal_title: `Delete command`,
                submit_modal_description: `Are you sure you want to delete the selected commands? If they are deleted, they can no longer be used`,
                cancel_modal_title: `Go to the previous page`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_submit_modal: true,
                alert_title: `Deletion success`,
                alert_description: `Successfully deleted ${commands_deleted_count} command(s)`
            });
        } else if (operation_success === 'false') {
            response.render('admin/command_list', {
                title: 'Commands',
                current_page_commands,
                server_commands,
                current_page_of_commands,
                total_command_files,
                total_number_of_pages,
                page_numbers,
                user: request.user,
                currentPage: '/admin/command_list',
                submit_modal_title: `Delete command`,
                submit_modal_description: `Are you sure you want to delete the selected commands? If they are deleted, they can no longer be used`,
                cancel_modal_title: `Go to the previous page`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_error_modal: true,
                alert_title: `Deletion failure`,
                alert_description: `There was an error when attempting to delete the selected command(s). Please try again`
            });
        }
    }
});

router.get(['/teleportcommands'], isLoggedIn, checkBotRepositoryInCache, async (request, response) => {
    let bot_teleport_commands;
    const botRepository = request.user.bot_repository;
    const teleport_commands_deleted_count = request.query.deleted;
    const operation_success = request.query.success;

    try {
        bot_teleport_commands = await botRepository.getAllBotTeleportCommands();
    } catch (error) {
        console.error(`There was an internal service error when attempting to read all the teleport command data from MongoDB: ${error}`);
        response.status(500).json({ error: `There was an internal service error when attempting to read all the teleport command data from MongoDB: ${error}` });
        return; // Ensure no further execution after error response
    }

    if (bot_teleport_commands) {
        const commands_per_page = 10;

        // Sort the teleport commands by name
        bot_teleport_commands.sort((a, b) => a.name.localeCompare(b.name));

        // Parse the 'range' query parameter
        const range = request.query.range || '1&10';
        const [start_range_number, end_range_number] = range.split('&').map(Number);

        // Calculate pagination variables
        const current_page_number = Math.ceil(start_range_number / commands_per_page);
        const total_number_of_pages = Math.ceil(bot_teleport_commands.length / commands_per_page);

        // Set up pagination display
        const visible_pages = 3;
        let start_page = Math.max(1, current_page_number - Math.floor(visible_pages / 2));
        let end_page = Math.min(total_number_of_pages, start_page + visible_pages - 1);
        start_page = Math.max(1, end_page - visible_pages + 1);
        const page_numbers = Array.from({ length: (end_page - start_page) + 1 }, (_, i) => i + start_page);

        // Get the teleport commands for the current page
        const current_page_commands = bot_teleport_commands.slice(start_range_number - 1, end_range_number);

        const server_commands = bot_teleport_commands; // All teleport commands for search functionality
        const total_command_files = bot_teleport_commands.length;
        const current_page_of_commands = current_page_number;

        if (typeof operation_success === 'undefined') {
            response.render('admin/teleport_command_list', {
                title: 'Teleport Commands',
                current_page_commands,
                server_commands,
                current_page_of_commands,
                total_command_files,
                total_number_of_pages,
                page_numbers,
                user: request.user,
                currentPage: '/admin/teleport_command_list',
                // Modal titles and descriptions
                submit_modal_title: 'Delete command',
                submit_modal_description: 'Are you sure you want to delete the selected teleport commands? This action cannot be undone.',
                cancel_modal_title: 'Go back',
                cancel_modal_description: 'Are you sure you want to go back to the previous page?',
            });
        } else if (operation_success === 'true') {
            response.render('admin/teleport_command_list', {
                title: 'Teleport Commands',
                current_page_commands,
                server_commands,
                current_page_of_commands,
                total_command_files,
                total_number_of_pages,
                page_numbers,
                user: request.user,
                currentPage: '/admin/teleport_command_list',
                // Modal titles and descriptions
                submit_modal_title: 'Delete command',
                submit_modal_description: 'Are you sure you want to delete the selected teleport commands? This action cannot be undone.',
                cancel_modal_title: 'Go back',
                cancel_modal_description: 'Are you sure you want to go back to the previous page?',
                show_submit_modal: true,
                alert_title: `Deletion success`,
                alert_description: `Successfully deleted ${teleport_commands_deleted_count} teleport command(s)`
            });
        } else if (operation_success === 'false') {
            response.render('admin/teleport_command_list', {
                title: 'Teleport Commands',
                current_page_commands,
                server_commands,
                current_page_of_commands,
                total_command_files,
                total_number_of_pages,
                page_numbers,
                user: request.user,
                currentPage: '/admin/teleport_command_list',
                // Modal titles and descriptions
                submit_modal_title: 'Delete command',
                submit_modal_description: 'Are you sure you want to delete the selected teleport commands? This action cannot be undone.',
                cancel_modal_title: 'Go back',
                cancel_modal_description: 'Are you sure you want to go back to the previous page?',
                show_error_modal: true,
                alert_title: `Deletion failure`,
                alert_description: `There was an error when attempting to delete the selected teleport command(s). Please try again`
            });
        }
    }
});

router.get('/players', isLoggedIn, checkBotRepositoryInCache, async (request, response) => {
    let server_players = undefined;
    const botRepository = request.user.bot_repository;
    const players_deleted_count = request.query.deleted;
    const operation_success = request.query.success;

    try {
        server_players = await botRepository.findAllUsers();
    } catch (error) {
        console.error(`There was an internal service error when attempting to read all the player data from MongoDB: ${error}`);
        response.status(500).json({error: `There was an internal service error when attempting to read all the player data from MongoDB: ${error}`});
        return;
    }

    if (server_players) {
        const players_per_page = 10;

        const range = request.query.range || '1&10';

        const [start_range_number, end_range_number] = range.split('&').map(Number);

        // Calculate the current page number
        const current_page_number = Math.ceil(start_range_number / players_per_page);

        // Calculate the total number of pages
        const total_number_of_pages = Math.ceil(server_players.length / players_per_page);

        const visible_players_per_page = 3;

        let start_page = Math.max(1, current_page_number - Math.floor(visible_players_per_page / 2));

        let end_page = Math.min(total_number_of_pages, start_page + visible_players_per_page - 1);

        start_page = Math.max(1, end_page - visible_players_per_page + 1);

        // Generate the list of page numbers to be displayed in the pagination
        const page_numbers = Array.from({length: (end_page - start_page) + 1}, (_, i) => i + start_page);

        // Slice the players array to only include the players for the current page
        const current_page_players = server_players.slice(start_range_number - 1, end_range_number);

        if (typeof operation_success === 'undefined') {
            response.render('admin/serverPlayers', {
                title: 'Players',
                user: request.user,
                currentPage: '/admin/serverPlayers',
                server_players,
                current_page_players,
                current_page_of_players: current_page_number,
                total_player_files: server_players.length,
                page_numbers,
                submit_modal_title: `Delete player from bot`,
                submit_modal_description: `Are you sure you want to delete the selected player(s)? If they are deleted, they will no longer be able to 
                communicate with the bot because they are no longer going to be registered`,
                cancel_modal_title: `Go to previous page`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
            });
        }

        // Second case: if operation_success is true, show success modal
        else if (operation_success === 'true') {
            response.render('admin/serverPlayers', {
                title: 'Players',
                server_players,
                current_page_players,
                current_page_of_players: current_page_number,
                total_player_files: server_players.length,
                page_numbers,
                user: request.user,
                submit_modal_title: `Delete player from bot`,
                submit_modal_description: `Are you sure you want to delete the selected player(s)? If they are deleted, they will no longer be able to 
                communicate with the bot because they are no longer going to be registered`,
                cancel_modal_title: `Go to previous page?`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                currentPage: '/admin/serverPlayers',
                show_submit_modal: true,
                alert_title: `Deletion success`,
                alert_description: `Successfully deleted ${players_deleted_count} players`
            });
        }

        // Third case: if operation_success is false, show error modal
        else if (operation_success === 'false') {
            response.render('admin/serverPlayers', {
                title: 'Players',
                server_players,
                current_page_players,
                current_page_of_players: current_page_number,
                total_player_files: server_players.length,
                page_numbers,
                user: request.user,
                submit_modal_title: `Delete player from bot`,
                submit_modal_description: `Are you sure you want to delete the selected player(s)? If they are deleted, they will no longer be able to 
                communicate with the bot because they are no longer going to be registered`,
                cancel_modal_title: `Go to previous page?`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_error_modal: true,
                alert_title: `Deletion failure`,
                alert_description: `There was an error when attempting to delete the selected players(s). Please try again`,
                currentPage: '/admin/serverPlayers'
            });
        }
    }
});


router.get("/player/:steam_id", isLoggedIn, checkBotRepositoryInCache, async function(request, response) {
    const steam_id = request.params.steam_id;
    const botRepository = request.user.bot_repository;
    let player = undefined;

    try {
        player = await botRepository.findUserById(steam_id);
    } catch (error) {
        console.error(`There was an internal service error when attempting to read the player data from MongoDB: ${error}`);
        return;
    }

    if (player) {
        response.render('admin/serverPlayer', {
            title: `Player details`,
            player,
            user: request.user,
            currentPage: `/players/${steam_id}`
        });
    } else {
        response.status(404).render('error', {
            message: `The player you wish to see was not found`,
            error: { status: 404 }
        });
    }
});

router.get('/discordchannelids', isLoggedIn, async (request, response) => {
    try {
        const show_submit_modal = request.session.show_submit_modal || false;
        const show_error_modal = request.session.show_error_modal || false;
        const alert_title = request.session.alert_title || '';
        const alert_description = request.session.alert_description || '';

        response.render('admin/discord_channel_ids', {
            user: request.user,
            title: `Discord channel ids`,
            currentPage: '/admin/discordchannelids',
            submit_modal_title: `Change Discord channel ids`,
            submit_modal_description: `Are you sure you want to change the Discord channel id values?`,
            cancel_modal_title: `Cancel changes?`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`,
            show_submit_modal,
            show_error_modal,
            alert_title,
            alert_description
        });
    } catch (error) {
        console.error(`There was an error when attempting to retrieve the page that allows you to change the Discord channel data. Please inform the server administrator of this error: ${error}`);
        response.render('admin/discord_channel_ids', {
            user: request.user,
            title: `Discord channel ids`
        });
    }
});

router.get('/ftpserverdata', isLoggedIn, async (request, response) => {
    try {
        const show_submit_modal = request.session.show_submit_modal || false;
        const show_error_modal = request.session.show_error_modal || false;
        const alert_title = request.session.alert_title || '';
        const alert_description = request.session.alert_description || '';

        response.render('admin/ftp_server_data', {
            user: request.user,
            title: `FTP server data`,
            currentPage: '/admin/ftpserverdata',
            submit_modal_title: `Change FTP server data`,
            submit_modal_description: `Are you sure you want to change the FTP server data?`,
            cancel_modal_title: `Cancel changes?`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`,
            show_submit_modal,
            show_error_modal,
            alert_title,
            alert_description
        });
    } catch (error) {
        console.error(`There was an error when attempting to retrieve the page that allows you to change the FTP server data. Please inform the server administrator of this error: ${error}`);
        response.render('admin/ftp_server_data', {
            user: request.user,
            title: `FTP server data`
        });
    }
});


router.get('/gameserverdata', isLoggedIn, (request, response) => {
    try {
        const show_submit_modal = request.session.show_submit_modal || false;
        const show_error_modal = request.session.show_error_modal || false;
        const alert_title = request.session.alert_title || '';
        const alert_description = request.session.alert_description || '';

        response.render('admin/game_server_data', {
            user: request.user,
            currentPage: '/admin/gameserverdata',
            title: `Game server data`,
            submit_modal_title: `Change SCUM server data`,
            submit_modal_description: `Are you sure you want to change your SCUM server IPv4 address and port number?`,
            cancel_modal_title: `Cancel changes?`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`,
            show_submit_modal,
            show_error_modal,
            alert_title,
            alert_description
        });
    } catch (error) {
        console.error(`There was an error when attempting to retrieve the page that allows you to set game server data: ${error}`);
        response.render('admin/game_server_data', {
            user: request.user,
            title: `Game server data`,
            info_message: `There was an error`
        });
    }
});


router.get('/spawncoordinates', isLoggedIn, (request, response) => {
    try {
        const show_submit_modal = request.session.show_submit_modal || false;
        const show_error_modal = request.session.show_error_modal || false;
        const alert_title = request.session.alert_title || '';
        const alert_description = request.session.alert_description || '';

        // Clear the session variables
        request.session.show_submit_modal = false;
        request.session.show_error_modal = false;
        request.session.alert_title = '';
        request.session.alert_description = '';

        response.render('admin/new_player_join_coordinates', {
            user: request.user,
            currentPage: '/admin/spawncoordinates',
            title: `Spawn zone coordinates`,
            submit_modal_title: `Change spawn zone coordinates`,
            submit_modal_description: `Are you sure you want to change new player spawn zone coordinates?`,
            cancel_modal_title: `Cancel changes?`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`,
            show_submit_modal,
            show_error_modal,
            alert_title,
            alert_description
        });
    } catch (error) {
        console.error(`There was an error when attempting to retrieve the page that allows you to set the spawn location of players. Please inform the server administrator of this error: ${error}`);
        response.render('admin/new_player_join_coordinates', {
            user: request.user,
            currentPage: '/admin/spawncoordinates',
            title: `Spawn zone coordinates`
        });
    }
});


router.get('/logfiles', isLoggedIn, async (request, response) => {
    const user_guild_id = request.user.guild_id;
    const info_log_files_blob = await logger.readAllLogsFromAzureContainer(`${user_guild_id}-info-logs`);
    const error_log_files_blob = await logger.readAllLogsFromAzureContainer(`${user_guild_id}-error-logs`);
    const chat_log_files_blob = await logger.readAllLogsFromAzureContainer(`${user_guild_id}-chat-logs`);
    const logins_log_files_blob = await logger.readAllLogsFromAzureContainer(`${user_guild_id}-login-logs`);
    try {
        response.render('admin/logs_page', { user: request.user, info_log_files: info_log_files_blob, error_log_files: error_log_files_blob, chat_log_files: chat_log_files_blob, login_and_logout_log_files: logins_log_files_blob, currentPage: '/admin/logfiles', title: `Log files`});
    } catch (error) {
        console.error(`There was an error when attempting to retrieve the page that allows you to view your log files. Please inform the server administrator of this error: ${error}`);
        response.render('admin/logs_page', { user: request.user, currentPage: `/admin/logfiles`, title: `Log files`});
    }
});

router.post('/setftpserverdata', isLoggedIn, checkBotRepositoryInCache,
    body('ftp_server_hostname_input')
    .isString()
    .trim()
    .notEmpty()
    .matches("^(25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)){3}$")
    .withMessage('The FTP server hostname field must contain a valid IPv4 address (between 0.0.0.0 and 255.255.255.255'),

    body('ftp_server_port_input')
    .isInt()
    .trim()
    .notEmpty()
    .matches("^(102[4-9]|10[3-9][0-9]|1[1-9][0-9]{2}|[2-9][0-9]{3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$")
    .withMessage('The FTP server port number must contain a number between 1000 and 65535'),

    body('ftp_server_username_input')
    .isString()
    .trim()
    .notEmpty()
    .matches("^[a-zA-Z0-9_]*$")
    .withMessage('The FTP server username must contain a string of characters'),

    body('ftp_server_password_input')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('The FTP server password must contain a string of characters'),

    async (request, response) => {

    const errors = validationResult(request);

    if (!errors.isEmpty()) {
        const error_messages = errors.array().map(error => error.msg);
        response.render('/admin/ftp_server_data', {
            user: request.user,
            currentPage:`/admin/ftp_server_data`,
            page_title: `FTP server data`,
            ftp_server_ip: request.body.ftp_server_hostname_input,
            ftp_server_port: request.body.ftp_server_port_input,
            ftp_server_username: request.body.ftp_server_username,
            ftp_server_password: request.body.ftp_server_password,
            show_error_modal: true,
            submit_modal_title: `Change FTP server data`,
            submit_modal_description: `Are you sure you want to change your FTP server data?`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`,
            cancel_modal_title: `Go back`,
            alert_title: `Input errors`,
            alert_description: error_messages
        });
    }

    const request_user_id = request.user.guild_id;
    const botRepository = request.user.bot_repository;

    const ftp_server_data_object = {
        guild_id: request_user_id,
        ftp_server_hostname: request.body.ftp_server_hostname_input,
        ftp_server_port: request.body.ftp_server_port_input,
        ftp_server_username: request.body.ftp_server_username_input,
        ftp_server_password: request.body.ftp_server_password_input
    };
    try {
        await botRepository.createBotFtpServerData(ftp_server_data_object);
        response.render('/admin/ftp_server_data', {
            user: request.user,
            currentPage:`/admin/ftp_server_data`,
            page_title: `FTP server data`,
            ftp_server_ip: request.body.ftp_server_hostname_input,
            ftp_server_port: request.body.ftp_server_port_input,
            ftp_server_username: request.body.ftp_server_username,
            ftp_server_password: request.body.ftp_server_password,
            show_submit_modal: true,
            submit_modal_title: `Change FTP server data`,
            submit_modal_description: `Are you sure you want to change your FTP server data?`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`,
            cancel_modal_title: `Go back`,
            alert_title: `Successfully updated FTP data`,
            alert_description: `You have successfully updated the details for your FTP server`
        });

    } catch (error) {
        response.render('/admin/ftp_server_data', {
            user: request.user,
            currentPage:`/admin/ftp_server_data`,
            page_title: `FTP server data`,
            ftp_server_ip: request.body.ftp_server_hostname_input,
            ftp_server_port: request.body.ftp_server_port_input,
            ftp_server_username: request.body.ftp_server_username,
            ftp_server_password: request.body.ftp_server_password,
            show_error_modal: true,
            submit_modal_title: `Change FTP server data`,
            submit_modal_description: `Are you sure you want to change your FTP server data?`,
            cancel_modal_description: `Are you sure you want to go back to the previous page?`,
            cancel_modal_title: `Go back`,
            alert_title: `Error updating your FTP server data`,
            alert_description: `There was an error when updating your FTP server data. Please try again or reach out to the server administrator if you believe this is an error: ${error}`
        });
    }
});

router.post("/createteleportcommand", isLoggedIn, checkBotRepositoryInCache,
    body('teleport_command_name_input')
        .trim()
        .isString()
        .withMessage('The teleport command name must be a valid string of lowercase and/or uppercase characters (a-z, A-Z)'),

    body('teleport_command_cost_input')
        .trim()
        .isNumeric()
        .withMessage('The teleport command cost must be a number'),

    body('x_coordinate_data_input')
        .trim()
        .isNumeric()
        .withMessage('The spawn zone x coordinate must be a number'),

    body('y_coordinate_data_input')
        .trim()
        .isNumeric()
        .withMessage('The spawn zone y coordinate must be a number'),

    body('y_coordinate_data_input')
        .trim()
        .isNumeric()
        .withMessage('The spawn zone z coordinate must be a number'),

    async function(request, response) {

        const errors = validationResult(request);
        if (!errors.isEmpty()) {
            const error_messages = errors.array().map(error => error.msg);
            // There are validation errors
            return response.render('admin/new_teleport_command', {
                user: request.user,
                currentPage: '/admin/new_teleport_command',
                page_title: 'New teleport command',
                // Preserve user inputs
                teleport_command_name: request.body.teleport_command_name_input,
                teleport_command_cost: request.body.teleport_command_cost_input,
                teleport_command_coordinates: request.body.paste_coordinates_input,
                teleport_command_x: request.body.x_coordinate_data_input,
                teleport_command_y: request.body.y_coordinate_data_input,
                teleport_command_z: request.body.z_coordinate_data_input,
                submit_modal_title: `Create teleport command`,
                submit_modal_description: `Are you sure you want to create this teleport command for your bot?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_error_modal: true,
                alert_title: "Input errors",
                alert_description: error_messages
            });
        }

        let operation_success = true;
        const x_coordinate = request.body.x_coordinate_data_input;
        const y_coordinate = request.body.y_coordinate_data_input;
        const z_coordinate = request.body.z_coordinate_data_input;
        const command_name = request.body.teleport_command_name_input;
        const command_cost = request.body.teleport_command_cost_input;
        const botRepository = request.user.bot_repository;

        const teleport_command = {
            name: command_name,
            cost: command_cost,
            x_coordinate: x_coordinate,
            y_coordinate: y_coordinate,
            z_coordinate: z_coordinate
        };

        try {
            await botRepository.createBotTeleportCommand(teleport_command);
            response.render('admin/new_teleport_command', {
                user: request.user,
                currentPage: `/admin/new_teleport_command`,
                page_title: `New teleport command`,
                alert_title: `Successfully created new teleport command`,
                alert_description: `You have successfully created a new bot teleport command and registered it with your bot`,
                show_submit_modal: true,
                teleport_command_name: request.body.teleport_command_name_input,
                teleport_command_cost: request.body.teleport_command_cost_input,
                teleport_command_coordinates: request.body.paste_coordinates_input,
                teleport_command_x: request.body.x_coordinate_data_input,
                teleport_command_y: request.body.y_coordinate_data_input,
                teleport_command_z: request.body.z_coordinate_data_input,
                submit_modal_title: `Create teleport command`,
                submit_modal_description: `Are you sure you want to create this teleport command for your bot?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`
            });
        } catch (error) {
            response.render('admin/new_teleport_command', {
                user: request.user,
                currentPage: `/admin/new_teleport_command`,
                page_title: `New teleport command`,
                alert_title: `Error creating new teleport command`,
                alert_description: `Please try creating the bot teleport command again or contact the server administrator if you believe this is an error: ${error}`,
                show_error_modal: true,
                teleport_command_name: request.body.teleport_command_name_input,
                teleport_command_cost: request.body.teleport_command_cost_input,
                teleport_command_coordinates: request.body.paste_coordinates_input,
                teleport_command_x: request.body.x_coordinate_data_input,
                teleport_command_y: request.body.y_coordinate_data_input,
                teleport_command_z: request.body.z_coordinate_data_input,
                submit_modal_title: `Create teleport command`,
                submit_modal_description: `Are you sure you want to create this item package for your bot?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`
            });
        }
});

router.post("/deleteteleportcommands", isLoggedIn, checkBotRepositoryInCache, async function(request, response)  {
    let operation_success = true;
    const botRepository = request.user.bot_repository;
    let teleport_command_names = request.body.command_names_checkbox;

    if (!teleport_command_names) {
        response.redirect('/admin/teleportcommands?deleted=0&success=false')
    }

    if (!Array.isArray(teleport_command_names)) {
        teleport_command_names = [teleport_command_names];
    }

    let teleport_command_count_deleted = 0;

    try {
        for (let i = 0; i < teleport_command_names.length; i++) {
            let teleport_command_deleted = await botRepository.deleteBotTeleportCommand(teleport_command_names[i]);
            if (teleport_command_deleted) {
                teleport_command_count_deleted++;
            } else {
                operation_success = false;
            }
        }
        response.redirect(`/admin/teleportcommands?deleted=${teleport_command_count_deleted}&success=${operation_success}`);
    } catch (error) {
        response.redirect('/admin/teleportcommands?deleted=0&success=false')
    }
});

router.post("/deleteusers", isLoggedIn, checkBotRepositoryInCache, async function(request, response) {
    /**
     * user_steam_ids_to_delete will be an array of steam ids
     */
    let operation_success = true;
    let user_steam_ids_to_delete = request.body.user_ids_checkbox;
    const botRepository = request.user.bot_repository;

    if (!(user_steam_ids_to_delete)) {
        response.redirect('/admin/players?deleted=0&success=false');
    }

    if (!Array.isArray(user_steam_ids_to_delete)) {
        user_steam_ids_to_delete = [user_steam_ids_to_delete];
    }

    let user_count_deleted = 0;

    try {
        for (let i = 0; i < user_steam_ids_to_delete.length; i++) {
            let user_deleted = await botRepository.deleteUser(user_steam_ids_to_delete[i]);

            if (user_deleted) {
                user_count_deleted++;
            } else {
                operation_success = false;
            }
        }
        response.redirect(`/admin/players?deleted=${user_count_deleted}&success=${operation_success}`);
    } catch (error) {
        response.redirect('/admin/players?deleted=0&success=false');
    }
});

router.post('/setspawncoordinates', isLoggedIn, checkBotRepositoryInCache,
    body('x_coordinate_data_input')
    .trim()
    .isNumeric()
    .withMessage('The spawn zone x coordinate must be a number'),

    body('y_coordinate_data_input')
    .trim()
    .isNumeric()
    .withMessage('The spawn zone y coordinate must be a number'),

    body('z_coordinate_input')
    .trim()
    .isNumeric()
    .withMessage('The spawn zone z coordinate must be a number'),

    async (request, response) => {
        const errors = validationResult(request);
        if (!errors.isEmpty()) {
            const error_messages = errors.array().map(error => error.msg);
            // There are validation errors
            return response.render('admin/new_player_join_coordinates', {
                user: request.user,
                currentPage: '/admin/new_player_join_coordinates',
                page_title: 'New player join coordinates',
                // Preserve user inputs
                teleport_command: request.body.paste_coordinates_input,
                teleport_command_x: request.body.x_coordinate_data_input,
                teleport_command_y: request.body.y_coordinate_data_input,
                teleport_command_z: request.body.z_coordinate_input,
                submit_modal_title: `Create teleport command`,
                submit_modal_description: `Are you sure you want to change your bot new player spawn area?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_error_modal: true,
                alert_title: "Input errors",
                alert_description: error_messages
            });
        }

        const request_user_id = request.user.guild_id;
        const botRepository = request.user.bot_repository;

        const coordinates_object = {
            guild_id: request_user_id,
            command_prefix: "#Teleport",
            x_coordinate: request.body.x_coordinate_data_input,
            y_coordinate: request.body.y_coordinate_data_input,
            z_coordinate: request.body.z_coordinate_input
        };
        try {
            await botRepository.createBotTeleportNewPlayerCoordinates(coordinates_object);
            return response.render('admin/new_player_join_coordinates', {
                user: request.user,
                currentPage: '/admin/new_player_join_coordinates',
                page_title: 'New player join coordinates',
                // Preserve user inputs
                teleport_command: request.body.paste_coordinates_input,
                teleport_command_x: request.body.x_coordinate_data_input,
                teleport_command_y: request.body.y_coordinate_data_input,
                teleport_command_z: request.body.z_coordinate_input,
                submit_modal_title: `Create teleport command`,
                submit_modal_description: `Are you sure you want to change your bot new player spawn area?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_submit_modal: true,
                alert_title: "Successfully updated spawn zone coordinates",
                alert_description: "You have successfully changed the spawn zone coordinates that new players will spawn at"
            });

        } catch (error) {
            console.error(`There was an error when attempting to update the spawn zone coordinates: ${error}`);
            // Store the error message in the session
            request.session.alert_title = 'Error updating spawn zone coordinates';
            request.session.alert_description = `Please try submitting this form again or contact the site administrator if you believe this is an error: ${error}`;
            request.session.show_error_modal = true;
            response.redirect('/admin/spawncoordinates');
            return response.render('admin/new_player_join_coordinates', {
                user: request.user,
                currentPage: '/admin/new_player_join_coordinates',
                page_title: 'New player join coordinates',
                // Preserve user inputs
                teleport_command: request.body.paste_coordinates_input,
                teleport_command_x: request.body.x_coordinate_data_input,
                teleport_command_y: request.body.y_coordinate_data_input,
                teleport_command_z: request.body.z_coordinate_input,
                submit_modal_title: `Create teleport command`,
                submit_modal_description: `Are you sure you want to change your bot new player spawn area?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_error_modal: true,
                alert_title: "Error updating spawn zone coordinates",
                alert_description: `Please try changing the spawn zone coordinates again or contact the site administrator if you believe this is an error: ${error}`
            });
        }
});


router.post('/setdiscordchannelids', isLoggedIn, checkBotRepositoryInCache,
    body('bot_ingame_chat_log_channel_id_input')
    .isString()
    .trim()
    .isNumeric()
    .matches("^[0-9]{17,25}$")
    .withMessage('The In-game discord channel id must consist of between 17 and 25 numbers between 0 and 9'),

    body('bot_ingame_logins_channel_id_input')
    .isString()
    .trim()
    .isNumeric()
    .matches("^[0-9]{17,25}$")
    .withMessage('The player login channel id must consist of between 17 and 25 numbers between 0 and 9'),

    body('bot_ingame_new_player_joined_id_input')
    .isString()
    .trim()
    .isNumeric()
    .matches("^[0-9]{17,25}$")
    .withMessage('The new player joins channel id must consist of between 17 and 25 numbers between 0 and 9'),

    body('battlemetrics_server_id_input')
    .isString()
    .trim()
    .isNumeric()
    .matches("^[0-9]{17,25}$")
    .withMessage('Your Battlemetrics server id must consist of between 17 and 25 numbers between 0 and 9'),

    body('bot_server_info_channel_id_input')
    .isString()
    .trim()
    .isNumeric()
    .matches("^[0-9]{17,25}$")
    .withMessage('The server info button channel id must consist of between 17 and 25 numbers between 0 and 9'),

    async (request, response) => {

        const errors = validationResult(request);
        if (!errors.isEmpty()) {
            const error_messages = errors.array().map(error => error.msg);
            // There are validation errors
            return response.render('admin/discord_channel_ids', {
                user: request.user,
                currentPage: '/admin/discord_channel_ids',
                page_title: 'New teleport command',
                // Preserve user inputs
                submit_modal_title: `Change discord channel ids`,
                submit_modal_description: `Are you sure you want to change your Discord server channel ids?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_error_modal: true,
                alert_title: "Input errors",
                alert_description: error_messages
            });
        }

        const request_user_id = request.user.guild_id;
        const botRepository = request.user.bot_repository;

        const discord_server_channel_ids_object = {
            guild_id: request_user_id,
            discord_ingame_chat_channel_id: request.body.bot_ingame_chat_log_channel_id_input,
            discord_logins_chat_channel_id: request.body.bot_ingame_logins_channel_id_input,
            discord_new_player_chat_channel_id: request.body.bot_ingame_new_player_joined_id_input,
            discord_battlemetrics_server_id: request.body.battlemetrics_server_id_input,
            discord_server_info_button_channel_id: request.body.bot_server_info_channel_id_input
        };
        try {
            await botRepository.createBotDiscordData(discord_server_channel_ids_object);
            return response.render('admin/new_player_join_coordinates', {
                user: request.user,
                currentPage: '/admin/new_teleport_command',
                page_title: 'New teleport command',
                // Preserve user inputs
                submit_modal_title: `Change discord channel ids`,
                submit_modal_description: `Are you sure you want to change your Discord server channel ids?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_submit_modal: true,
                alert_title: "Successfully changed Discord channel ids",
                alert_description: "You have successfully changed your Discord server channel id's"
            });
        } catch (error) {
            return response.render('admin/new_player_join_coordinates', {
                user: request.user,
                currentPage: '/admin/new_teleport_command',
                page_title: 'New teleport command',
                // Preserve user inputs
                submit_modal_title: `Change discord channel ids`,
                submit_modal_description: `Are you sure you want to change your Discord server channel ids?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_error_modal: true,
                alert_title: "Error changing Discord channel ids",
                alert_description: `Please try submitting this form again or contact the site administrator if you believe this is an error: ${error}`
            });
        }
});

router.post('/setgameserverdata', isLoggedIn, checkBotRepositoryInCache,
    body('game_server_hostname_input')
    .isString()
    .trim()
    .notEmpty()
    .matches("^(25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)){3}$")
    .withMessage('Your game server hostname (IPv4 address) must be a valid IPv4 address between 0.0.0.0 and 255.255.255.255'),

    body('game_server_port_input')
    .isNumeric()
    .trim()
    .notEmpty()
    .matches("^(102[4-9]|10[3-9][0-9]|1[1-9][0-9]{2}|[2-9][0-9]{3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$")
    .withMessage('Your game server port must be a number between 1024 and 65535'),

    async (request, response) => {

        const errors = validationResult(request);
        if (!errors.isEmpty()) {
            const error_messages = errors.array().map(error => error.msg);
            // There are validation errors
            return response.render('admin/game_server_data', {
                user: request.user,
                currentPage: '/admin/game_server_data',
                page_title: 'Game server data',
                // Preserve user inputs
                submit_modal_title: `Change discord channel ids`,
                submit_modal_description: `Are you sure you want to change your Discord server channel ids?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_error_modal: true,
                alert_title: "Input errors",
                alert_description: error_messages
            });
        }

        const request_user_id = request.user.guild_id;
        const botRepository = request.user.bot_repository;

        const game_server_data = {
            guild_id: request_user_id,
            game_server_hostname_input: request.body.game_server_hostname_input,
            game_server_port_input: request.body.game_server_port_input
        };
        try {
            await botRepository.createBotGameServerData(game_server_data);
            return response.render('admin/game_server_data', {
                user: request.user,
                currentPage: '/admin/game_server_data',
                page_title: 'Game server data',
                // Preserve user inputs
                submit_modal_title: `Change discord channel ids`,
                submit_modal_description: `Are you sure you want to change your Discord server channel ids?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_submit_modal: true,
                alert_title: "Successfully changed game server data",
                alert_description: `You have successfully changed the game server IPv4 address and port number`
            });
        } catch (error) {
            return response.render('admin/game_server_data', {
                user: request.user,
                currentPage: '/admin/game_server_data',
                page_title: 'Game server data',
                // Preserve user inputs
                submit_modal_title: `Change discord channel ids`,
                submit_modal_description: `Are you sure you want to change your Discord server channel ids?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_error_modal: true,
                alert_title: "Error changing game server data",
                alert_description: `Please try submitting this form again or contact the server administrator if you believe this is an error: ${error}`
            });
        }
});


router.post('/botcommand/new', isLoggedIn, checkBotRepositoryInCache,
    body('command_name')
    .trim()
    .notEmpty()
    .matches("^[A-Za-z0-9]{1,50}$")
    .withMessage('The command name can be a maximum of 50 characters and numbers'),

    body('command_description')
    .trim()
    .notEmpty()
    .matches("^[A-Za-z0-9\\-_=+\\{};:'\",<.>/?\\[\\] ]{1,1000}$")
    .withMessage('The command description can be a maximum of 1000 characters and numbers'),

    body('command_cost')
    .isNumeric()
    .matches("^[0-9]{1,6}$")
    .withMessage('The command cost must be a number between 0 and 6 digits long'),

    async (request, response, next) => {

        const errors = validationResult(request);
        if (!errors.isEmpty()) {
            const error_messages = errors.array().map(error => error.msg);
            // There are validation errors
            return response.render('admin/new_command', {
                user: request.user,
                currentPage: '/admin/command_list',
                page_title: 'Create new command',
                // Preserve user inputs
                command_name: request.body.command_name,
                command_description: request.body.command_description,
                command_cost: request.body.command_cost,
                submit_modal_title: `Create item package`,
                submit_modal_description: `Are you sure you want to create this item package for your bot?`,
                cancel_modal_title: `Go back`,
                cancel_modal_description: `Are you sure you want to go back to the previous page?`,
                show_error_modal: true,
                alert_title: "Input errors",
                alert_description: error_messages
            });
        }


        const new_command_name = request.body.command_name;
        const new_command_description = request.body.command_description;
        const command_cost = request.body.command_cost_input;
        let command_items = request.body.item_input_value;
        const botRepository = request.user.bot_repository;

        if (!Array.isArray(command_items)) {
            command_items = [command_items];
        }

        const new_bot_package = {
            package_name: new_command_name,
            package_description: new_command_description,
            package_cost: command_cost,
            package_items: command_items
        };

        try {
            await botRepository.createBotItemPackage(new_bot_package);
            response.render('admin/new_command', {
                user: request.user,
                currentPage: '/admin/command_list',
                page_title:`Create new command`,
                alert_title: `Successfully created new package`,
                alert_description: `You have successfully created a new item package and registered it with your bot`,
                show_submit_modal: true
            });
        } catch (error) {
            response.render('admin/new_command', {
                user: request.user,
                currentPage: '/admin/command_list',
                page_title:`Error`,
                alert_title: `Error creating new package`,
                alert_description: `Please try submitting this form again or contact the server administrator if you believe this is an error: ${error}`,
                show_error_modal: true
            });
        }
});

router.post('/deletecommands', isLoggedIn, checkBotRepositoryInCache, async (request, response) => {
    const botRepository = request.user.bot_repository;
    let operation_success = true;
    let command_names_to_delete = request.body.command_names_checkbox;

    if (!(command_names_to_delete)) {
        response.redirect('/admin/commands')
    }

    if (!Array.isArray(command_names_to_delete)) {
        command_names_to_delete = [command_names_to_delete];
    }

    let commands_deleted_count = 0;

    try {
        for (let i = 0; i < command_names_to_delete.length; i++) {
            let package_deleted = await botRepository.deleteBotPackageByName(command_names_to_delete[i]);

            if (package_deleted) {
                commands_deleted_count++;
            } else {
                operation_success = false;
            }
        }

        response.redirect(`/admin/commands?deleted=${commands_deleted_count}&success=${operation_success}`);
    } catch (error) {
        response.redirect('/admin/commands?deleted=0&success=false');
    }
});

export default router;
