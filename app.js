import { config } from 'dotenv';
config({ path: '.env' });


/**
 * Nodejs and express specific dependencies
 */
import createError from 'http-errors';
import express from 'express';
import path from 'path';
import { dirname} from 'path'
import cookieParser from 'cookie-parser';
import logger from 'morgan';
import session from 'express-session';
import crypto from 'crypto';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import fs from 'fs';
import FTPClient from 'ftp';
import MongoStore from 'connect-mongo';
import { Client, Collection, GatewayIntentBits, REST, Routes, Events, ChannelType, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import myEmitter from './utils/EventEmitter.js'
import Queue from './utils/Queue.js'
import Logger from './utils/Logger.js';
import ServerInfoCommand from './api/battlemetrics/ServerInfoCommand.js';
import { hashPassword, validatePassword } from './modules/hashAndValidatePassword.js';
import BotRepository from './database/MongoDb/BotRepository.js';
import { Mutex } from 'async-mutex';
import indexRouter from './routes/index.js';
import adminRouter from './routes/admin.js';
import apiExecutableRecompilation from './api/recompile/recompile-executable.js';
import SteamUserInfoCommand from './api/steam/SteamUserInfoCommand.js';
import Cache from './utils/Cache.js';
import { E_CANCELED } from 'async-mutex';
import { fileURLToPath, pathToFileURL } from 'url';
import WebSocket from 'ws';
import http from 'http';
import { WebSocketServer } from 'ws';

const bot_token = process.env.bot_token;

const client_instance = new Client({
    intents:
        [GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
    ]
});

const message_logger = new Logger();
const cache = new Cache();
/**
 * The following regex string is for steam ids associated with a steam name specifically for the login log file.
 * They are saved as a 17-digit number (e.g. 12345678912345678)
 */
const login_log_steam_id_regex = /([0-9]{17})/g;

/**
 * The following regex string is for steam ids associated with a steam name specifically for the chat log file.
 * Like the login file, they are saved as a 17-digit number (e.g. 12345678912345678)
 */
const chat_log_steam_id_regex = /([0-9]{17})/g;

/**
 * The following regex string is for steam names which match the same format as the ones in gportal's ftp files: username(number); e.g. boss612man(100)
 */
const login_log_steam_name_regex = /([a-zA-Z0-9 ._-]{0,32}\([0-9]{1,10}\))/g;

/**
 * The following regex string is to identify and extract the ipv4 address from gportal's ftp log files.
 * An example message will look like the following: 2023.12.19-17.18.57: '72.140.43.39 76561198244922296:jacobdgraham02(2)' logged in at: X=218481.953 Y=243331.516 Z=28960.289
 * We want to extract only the substring '72.140.43.39'
 */
const ipv4_address_regex = /'((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}/g;

/**
 * The below commented out regex string matches all of the chat log messages sent by the chat bot, Wilson. This regex string can be used to keep track of Wilson.
 * const chat_log_messages_from_wilson_regex = /('76561199505530387:Wilson\24\' '?:Local|Global|Admin:.*)'/g;
 */

/**
 * The following regex string is for chat messages when they appear in the chat log file.
 */
const chat_log_messages_regex = /(?<=Global: |Local: |Admin: |Squad: )\/[^\n]*[^'\n]/g;

/**
 * The following 3 strings must be hardcoded according to how the gportal ftp server is structured. The use of 2 \\ characters is necessary to equal one \ character
 */
const gportal_ftp_server_target_directory = 'SCUM\\Saved\\SaveFiles\\Logs\\';
const gportal_ftp_server_filename_prefix_login = 'login_';
const gportal_ftp_server_filename_prefix_chat = 'chat_';

const coordinate_regex = /X=([-?\d.]+) Y=([-?\d.]+) Z=([-?\d.]+)/;

const logged_in_at_regex = /logged in at/;

const logged_out_at_regex = /logged out at/;

const mutex = new Mutex();

var expressServer = express();
/**
 * Initial configuration to enable express to use Mongodb as a storage location for session information
 */
expressServer.use(session({
    secret: process.env.express_session_key,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.mongodb_connection_string })
}));

expressServer.use(passport.initialize());
expressServer.use(passport.session());

/**
 * A class instance which holds a function that hits the Battlemetrics server API
 */

const steam_web_api_player_info = new SteamUserInfoCommand(process.env.steam_web_api_key);

/**
 * This function loops through each of the strings located in the string array 'logs', and parses out various substrings to manipulate them.
 *
 * @param {string[]} logs An array of strings that represents the contents of the FTP login file on gportal.
 * */
async function determinePlayerLoginSessionMoney(guild_id, logs) {
    const user_balance_updates = new Map();

    if (!Array.isArray(logs)) {
        throw new Error('Invalid logs array');
    }

    const bot_repository = cache.get(`bot_repository_${guild_id}`);

    for (const log of logs) {
        if (!log || log.includes("Game version: ")) {
            continue;
        }
        /**
         * The result of log.split(": ") is an array containing a substring before and after the ':' character in each string 'log'. The destructured array variable 'logTimestamp'
         * contains the substring before the ':' character, and the array variable 'logMessage' contains the substring after the ':' character.
         */
        const [logTimestamp, logMessage] = log.split(": ");

        if (logMessage.includes('logged in') || logMessage.includes('logged out')) {
            const matchResult = logMessage.match(/'(.*?) (.*?):(.*?)'(.*?)(logged in|logged out)/);

            if (matchResult) {
                /**
                 * If a string is found to match all of the rules defined in the regex pattern /'(.*?) (.*?):(.*?)(logged in|logged out)/, an array containing 6 values will be returned.
                 * We are only interested in the 3rd and 6th value, so we ignore the other values in the array by using the , character.
                 * By using the logTimestamp substring stored earlier, we can replace individual characters in the substring to construct a string which can be converted into a valid
                 * javascript object. The format for a javascript Date object used here is as follows: YYYY-MM-DDTHH:mm:ss. If you are interested, this matches the pattern presented in widely-
                 * accepted ISO 8601 date format.
                 */
                const [, , user_steam_id, , , user_logged_in_or_out] = matchResult;
                const formatted_date_and_time = new Date(logTimestamp.replace('-', 'T').replace(/\./g, '-').replace(/(?<=T.*)-/g, ':'));

                /**
                 * Each time the user logs in, a Map is updated with their log in steam id and time, so we can begin the process of giving them some amount of discord money depending
                 * on the length of time that has spanned between their current log in time and their future log out time. Once the user has logged out, we need to fetch their log
                 * in time from the Map.
                 */
                if (user_logged_in_or_out === 'logged in') {
                    cache.set(`login_time_${user_steam_id}`, formatted_date_and_time);
                } else if (user_logged_in_or_out === 'logged out') {
                    const login_time = cache.get(`login_time_${user_steam_id}`);
                    /**
                     * The variable calculated_elapsed_time holds the value in milliseconds. Therefore, to get the time in hours, we have to perform the math calculation 1000 / 60 / 60.
                     * Now that we have the play time in hours, we can multiply that play time by 1000 to get the amount of money they will get. Let us suppose initially a user has 0
                     * discord money. Next, they play on our server for 1.5 hours and log off. Then, their total amount of money earned will be 1500.
                     * After we record the user log in and log out time, we will delete that record from the Map to ensure we do not duplicate the money-giving operation.
                     */
                    if (login_time) {
                        const calculated_elapsed_time = ((formatted_date_and_time - login_time) / 1000 / 60 / 60);
                        const user_account_balance = Math.round(calculated_elapsed_time * 1000);

                        // message_logger.writeLogToAzureContainer(
                        //     `InfoLogs`,
                        //     `User ${user_steam_id} has an added account balance of ${user_account_balance}`,
                        //     guild_id,
                        //     `${guild_id}-info-logs`
                        // );

                        user_balance_updates.set(user_steam_id, user_account_balance);
                        cache.delete(`login_time_${user_steam_id}`);
                    }
                }
            }
        }
    }

    /**
     * This is the loop which fetches both the user steam id and their total amount of discord money earned from the Map. For each user within the Map that has both a log in and log out time,
     * their database record is updated with the amount of money they earned in this specific play session.
     * If the operation fails for whatever reason, the expressServer developer will get an email stating this, and the expressServer will also crash.
     */
    for (const [user_steam_id, update] of user_balance_updates) {
        try {
            await bot_repository.updateUserAccountBalance(user_steam_id, update, guild_id);
            user_balance_updates.delete(user_steam_id);
        } catch (database_updated_error) {
            // message_logger.writeLogToAzureContainer(
            //     `ErrorLogs`,
            //     `Failed to update the user account balance for user with steam id ${user_steam_id}`,
            //     guild_id,
            //     `${guild_id}-error-logs`
            // );
        }
    }
}

async function createNewFtpClient(guild_id, ftp_server_data) {
    const gportal_ftp_config = {
        host: ftp_server_data.ftp_server_ip,
        port: ftp_server_data.ftp_server_port,
        user: ftp_server_data.ftp_server_username,
        password: ftp_server_data.ftp_server_password,
        connTimeout: 600000,
        keepAlive: 10000
    };

    const gportal_log_file_ftp_client = new FTPClient();

    return await new Promise((resolve, reject) => {
        const cleanupListeners = () => {
            gportal_log_file_ftp_client.removeAllListeners();
        }
        gportal_log_file_ftp_client.on('ready', () => {
            // message_logger.writeLogToAzureContainer(
            //     `InfoLogs`,
            //     `The FTP connection has been successfully established`,
            //     guild_id,
            //     `${guild_id}-info-logs`
            // );
            cleanupListeners();
            cache.set(`ftp_server_configuration_${guild_id}`, gportal_log_file_ftp_client);
            resolve(gportal_log_file_ftp_client);
        });
        gportal_log_file_ftp_client.on('error', (error) => {
            // message_logger.writeLogToAzureContainer(
            //     `ErrorLogs`,
            //     `There was a connection error with the FTP server: ${error.message}`,
            //     guild_id,
            //     `${guild_id}-error-logs`
            // );
            cleanupListeners();
            reject(error);
        });
        gportal_log_file_ftp_client.on('close', () => {
            // message_logger.writeLogToAzureContainer(
            //     `InfoLogs`,
            //     `The FTP connection has been closed. Attempting to reconnect with the FTP server`,
            //     guild_id,
            //     `${guild_id}-info-logs`
            // );
            cleanupListeners();
            retryConnection(guild_id, ftp_server_data);
        });

        gportal_log_file_ftp_client.connect(gportal_ftp_config);
    });
}

async function establishFtpConnectionToGPortal(guild_id, ftp_server_data) {
    try {
        const ftp_client = await createNewFtpClient(guild_id, ftp_server_data);
        cache.set(`ftp_server_configuration_${guild_id}`, ftp_client);
        return ftp_client;
    } catch (error) {
        console.error(`Failed to establish FTP connection for guild ${guild_id}: ${error}`);
        throw error;
    }
}

/**
 * Attempts to reconnect to the GPortal FTP server when the connection is severed. Used in conjunction with the @establishFtpConnectionToGportal function
 */
function retryConnection(guild_id, ftp_server_data) {
    console.log(`Retrying connection to FTP server for guild ${guild_id} in ${RETRY_DELAY / 1000} seconds`);
    const ftp_retry_delay = 5000;
    // message_logger.writeLogToAzureContainer(
    //     `InfoLogs`,
    //     `Retrying connection to FTP server`,
    //     guild_id,
    //     `${guild_id}-info-logs`
    // );
    setTimeout(async() => {
        try {
            const ftp_client = await establishFtpConnectionToGPortal(guild_id, ftp_server_data);
        } catch (error) {
            retryConnection(guild_id, ftp_server_data);
        }
    }, ftp_retry_delay);
}

/**
 * This asynchronous function reads login log files from the FTP server hosted on GPortal for my SCUM server
 * The npm package 'FTP' provides functionality to process the data fetched from the GPortal FTP server and extract the relevant
 * steam id of the invoker, and their associated in-game chat message
 * @param {Object} request An HTTP request object which attempts to query data from the FTP server
 * @param {any} response An HTTP response object which holds the query results obtained from the FTP server
 * @returns {Array} An array containing object(s) in the following format: {steam_id: string, player_message: string}
 */
async function readAndFormatGportalFtpServerLoginLog(bot_repository, guild_id, ftp_client) {
    let stream = null;
    let ftp_file_bulk_contents = '';
    let ftp_file_processed_contents_string_array = [];
    let received_chat_login_messages = [];
    let player_ipv4_addresses = [];
    let user_steam_ids = {};
    let last_line_processed = cache.get(`last_line_processed_${guild_id}`) || 0;
    const channel_for_joins = cache.get(`discord_channel_for_logins_${guild_id}`);
    const channel_for_new_joins = cache.get(`discord_channel_for_new_joins_${guild_id}`);

    try {
        const files = await new Promise((resolve, reject) => {
            ftp_client.list(gportal_ftp_server_target_directory, async (error, files) => {
                if (error) {
                    // await message_logger.writeLogToAzureContainer(
                    //     `ErrorLogs`,
                    //     `There was an error when attempting to retrieve the login files from GPortal FTP server: ${error}`,
                    //     guild_id,
                    //     `${guild_id}-error-logs`
                    // );
                    reject('Failed to retrieve file listing');
                } else {
                    resolve(files);
                }
            });
        });

        const matching_files = files
            .filter(file => file.name.startsWith(gportal_ftp_server_filename_prefix_login))
            .sort((file_one, file_two) => file_two.date - file_one.date);

        if (matching_files.length === 0) {
            // await message_logger.writeLogToAzureContainer(
            //     `ErrorLogs`,
            //     `No files were found that started with the prefix ${gportal_ftp_server_filename_prefix_login}`,
            //     guild_id,
            //     `${guild_id}-error-logs`
            // );
            return;
        }

        const file_path = `${gportal_ftp_server_target_directory}${matching_files[0].name}`;

        stream = await new Promise((resolve, reject) => {
            ftp_client.get(file_path, async (error, stream) => {
                if (error) {
                    // await message_logger.writeLogToAzureContainer(
                    //     `ErrorLogs`,
                    //     `The FTP file was present in GPortal, but could not be fetched: ${error}`,
                    //     guild_id,
                    //     `${guild_id}-error-logs`
                    // );
                    reject(new Error(`The ftp login file was present in GPortal, but could not be fetched. ${error}`));
                } else {
                    resolve(stream);
                }
            });
        });

        await new Promise((resolve, reject) => {
            stream.on('data', (chunk) => {
                const processed_chunk = chunk.toString().replace(/\u0000/g, '');
                ftp_file_bulk_contents += processed_chunk;
            });

            stream.on('end', async () => {
                ftp_file_processed_contents_string_array = ftp_file_bulk_contents.split('\n');

                // Process only new lines
                for (let i = last_line_processed; i < ftp_file_processed_contents_string_array.length; i++) {
                    const currentLine = ftp_file_processed_contents_string_array[i];
                    received_chat_login_messages.push(currentLine);

                    // Extract IPV4 address
                    const ipv4_match = currentLine.match(ipv4_address_regex);
                    if (ipv4_match && ipv4_match.length > 0) {
                        const ipv4_address = ipv4_match[0].substring(1); // Remove the leading '
                        player_ipv4_addresses.push(ipv4_address);
                    }

                    // Extract steam IDs and messages
                    const steam_id_match = currentLine.match(login_log_steam_id_regex);
                    const steam_name_match = currentLine.match(login_log_steam_name_regex);
                    if (steam_id_match && steam_name_match) {
                        const steam_id = steam_id_match[0];
                        const steam_name = steam_name_match[0];
                        user_steam_ids[steam_id] = steam_name;
                    }
                }

                // Update the cache with the last processed line index
                last_line_processed = ftp_file_processed_contents_string_array.length;
                cache.set(`last_line_processed_${guild_id}`, last_line_processed);

                cache.set(`received_chat_login_messages_${guild_id}`, received_chat_login_messages);
                cache.set(`player_ipv4_addresses_${guild_id}`, player_ipv4_addresses);
                cache.set(`user_steam_ids_${guild_id}`, user_steam_ids);

                // Calculate current content hash
                const current_file_contents_hash = crypto.createHash('md5').update(ftp_file_bulk_contents).digest('hex');
                // Check if the hash differs from the previous one
                const previous_login_file_hash = cache.get(`current_login_log_hash_${guild_id}`);
                if (current_file_contents_hash === previous_login_file_hash) {
                    return;
                }
                cache.set(`player_ftp_log_login_messages_${guild_id}`, ftp_file_processed_contents_string_array);

                await sendPlayerLoginMessagesToDiscord(
                    received_chat_login_messages,
                    channel_for_joins,
                    guild_id
                );

                await insertSteamUsersIntoDatabase(
                    Object.keys(user_steam_ids),
                    Object.values(user_steam_ids),
                    guild_id
                );

                await determinePlayerLoginSessionMoney(
                    guild_id,
                    cache.get(`received_chat_login_messages_${guild_id}`)
                );

                await teleportNewPlayersToLocation(
                    bot_repository,
                    Object.keys(user_steam_ids),
                    channel_for_new_joins,
                    guild_id
                );

                cache.set(`current_login_log_hash_${guild_id}`, current_file_contents_hash);

                resolve();
            });

            stream.on('error', reject);
        });
    } catch (error) {
        // await message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `There was an error when processing the GPortal FTP login log file: ${error}`,
        //     guild_id,
        //     `${guild_id}-error-logs`
        // );
    } finally {
        if (stream) {
            stream = null;
        }
    }
}

/**
 * This function determines if players joining the server are new. If so, they are teleported to a specific area on the map.
 * The players are teleported to a specific area so they can read relevant server information.
 * If the mongodb database results return a user who has the property 'user_joining_server_first_time' as a value of '0', a command will be executed
 * in-game that sends them to a specific location on the game map which tells them starter information they need to know
 *
 * @param {any} online_users a Map containing the key-value pairs of user steam id and user steam name
 */
async function teleportNewPlayersToLocation(bot_repository, user_steam_ids, channel_for_new_joins, guild_id) {
    const bot_user = await bot_repository.getBotDataByGuildId(guild_id);

    if (!bot_user) {
        return;
    }

    if (!(bot_user.x_coordinate && bot_user.y_coordinate && bot_user.z_coordinate)) {
        return;
    }

    const bot_user_x_coordinate = bot_user.x_coordinate;
    const bot_user_y_coordinate = bot_user.y_coordinate;
    const bot_user_z_coordinate = bot_user.z_coordinate;

    /**
     * Iterate over the user_steam_ids array
     */
    for (let i = 0; i < user_steam_ids.length; i++) {
        const steam_id = user_steam_ids[i];

        /*
        Only find a user in the MongoDB database if they have not yet joined the server (i.e. with the property 'user_joining_server_first_time' equal to 0)
        After a user joins the server, that property is updated to contain a value of '1'
        */
        const user_first_join_results = await bot_repository.findUserByIdIfFirstServerJoin(steam_id);

        if (user_first_join_results) {
            try {
                myEmitter.emit('newUserJoinedServer', steam_id, channel_for_new_joins, guild_id);
            } catch (error) {
                // await message_logger.writeLogToAzureContainer(
                //     `ErrorLogs`,
                //     `An error occurred when sending the new player login messages to discord: ${error}`,
                //     guild_id,
                //     `${guild_id}-error-logs`
                // );
            }

            try {
                const teleport_coordinates = {
                    x: bot_user_x_coordinate,
                    y: bot_user_y_coordinate,
                    z: bot_user_z_coordinate
                }
                await teleportPlayerToLocation(teleport_coordinates, guild_id, steam_id);
            } catch (error) {
                // await message_logger.writeLogToAzureContainer(
                //     `ErrorLogs`,
                //     `An error occurred when attempting to teleport the player to the spawn location area: ${error}`,
                //     guild_id,
                //     `${guild_id}-error-logs`
                // );
            }

            await bot_repository.updateUser(steam_id, { user_joining_server_first_time: 1 });
        }
    }
}


/**
 * This asynchronous function reads chat log files from the FTP server hosted on GPortal for my SCUM server
 * The npm package 'FTP' provides functionality to process the data fetched from the GPortal FTP server and extract the relevant
 * steam id of the invoker, and their associated in-game chat message
 * @param {Object} request An HTTP request object which attempts to query data from the FTP server
 * @param {any} response An HTTP response object which holds the query results obtained from the FTP server
 * @returns {Array} An array containing object(s) in the following format: {steam_id: string, player_message: string}
 */
async function readAndFormatGportalFtpServerChatLog(guild_id, ftp_client) {
    let stream = undefined;
    let file_contents_steam_id_and_messages = [];
    let received_chat_messages = [];
    let browser_file_contents_lines = undefined;
    let browser_file_contents = '';
    let initial_last_line_processed = 0;

    try {
        /**
         * Fetch a list of all the files in the specified directory on GPortal. In this instance, we fetch all of the files from
         * the path 'SCUM\\Saved\\SaveFiles\\Logs\\', which will give us access to the chat log file that we need
         */
        const files = await new Promise((resolve, reject) => {
            ftp_client.list(gportal_ftp_server_target_directory, (error, files) => {
                if (error) {
                    // message_logger.writeLogToAzureContainer(
                    //     `ErrorLogs`,
                    //     `Failed to retrieve file listings from GPortal: ${error.message}`,
                    //     guild_id,
                    //     `${guild_id}-error-logs`
                    // );
                    reject(new Error(`Failed to retrieve file listings: ${error.message}`));
                } else {
                    resolve(files);
                }
            });
        });

        /**
         * Based on the log files that we obtained from querying the FTP server, we must filter the chat log files based on a filename prefix and
         * sort by date. To obtain the chat logs, we must filter by the file name 'chat_'+most_recent_date', as the file name is 'chat_'+Date+'.log'
         * E.g. 'chat_202030831164431.log'
         */
        const matching_files = files
            .filter(file => file.name.startsWith(gportal_ftp_server_filename_prefix_chat))
            .sort((file_one, file_two) => file_two.date - file_one.date);

        /**
         * If no matching file names were found in the GPortal FTP server query result, we return a JSON response of an internal server error
         * indicating that no target files were found
         */
        if (matching_files.length === 0) {
            // message_logger.writeLogToAzureContainer(
            //     `ErrorLogs`,
            //     `No files were found that started with the prefix ${gportal_ftp_server_filename_prefix_chat}: ${error}`,
            //     guild_id,
            //     `${guild_id}-error-logs`
            // );
            return;
        }

        /**
         * From the list of chat files retrieved with the date appended to the file name, fetch the file name with the most recent appended date
         */
        const file_path = `${gportal_ftp_server_target_directory}${matching_files[0].name}`;
        stream = await new Promise((resolve, reject) => {
            ftp_client.get(file_path, (error, stream) => {
                if (error) {
                    // message_logger.writeLogToAzureContainer(
                    //     `ErrorLogs`,
                    //     `The file is present in GPortal, but can not be fetched: ${error}`,
                    //     guild_id,
                    //     `${guild_id}-error-logs`
                    // );
                    reject(new Error(`The file was present in gportal, but could not be fetched: ${error}`));
                }
                else {
                    resolve(stream);
                }
            });
        });

        /**
         * Process the incoming data stream from the FTP server query result and append individual data chunks prevent excessive memory usage
         * or potential memory leaks
         */
        await new Promise((resolve, reject) => {
            stream.on('data', async (chunk) => {

                /**
                 * Remove null characters from the incoming data streams and replace them with empty strings to avoid any null errors
                 */
                const processed_chunk = chunk.toString().replace(/\u0000/g, '');
                browser_file_contents += processed_chunk;

                /**
                 * Split the incoming data stream into individual lines so as to allow iteration over each of the lines individually
                 * This makes extracting any data much easier, or in some cases possible
                 */
                browser_file_contents_lines = browser_file_contents.split('\n');

                /**
                 * Whenever the bot restarts, prevent duplicate older log files from being re-read and processed by the program. Set the first line to be processed as the total
                 * number of lines that currently exist in the FTP file.
                 */
                const initial_line_been_processed = cache.get(`initial_line_been_processed_chat_log_${guild_id}`);

                if (!initial_line_been_processed) {
                    cache.set(`initial_line_been_processed_chat_log_${guild_id}`, browser_file_contents_lines.length);
                }

                initial_last_line_processed = cache.get(`last_line_processed_ftp_chat_log_${guild_id}`);

                if (!initial_last_line_processed) {
                    initial_last_line_processed = 0;
                }

                if (browser_file_contents_lines.length > 1) {
                    for (let i = initial_last_line_processed; i < browser_file_contents_lines.length; i++) {
                        received_chat_messages.push(browser_file_contents_lines[i]);
                        /**
                         * When iterating through the stored strings, if any substring matches the regex patterns for user steam ids or user messages,
                         * append both the user steam id and user in-game message into an array which we will return
                         */
                        if (browser_file_contents_lines[i].match(chat_log_messages_regex)) {
                            file_contents_steam_id_and_messages.push({
                                key: browser_file_contents_lines[i].match(chat_log_steam_id_regex),
                                value: browser_file_contents_lines[i].match(chat_log_messages_regex)
                            });
                        }
                    }
                }
            });
            stream.on('end', async () => {
                /**
                * Set the last line processed in the FTP file so that we do not re-read any file content which we have read already. This will assist administrators
                * in keeping track of messages that have already been processed.
                */
                cache.set(`last_line_processed_ftp_chat_log_${guild_id}`, browser_file_contents_lines.length);
                /**
                 * If a data stream from the FTP server was properly terminated and returned some results, we will create a hash of those results
                 * and will not execute the function again if subsequent hashes are identical.
                 */
                if (browser_file_contents.length > 1) {
                    const current_chat_log_file_hash = crypto.createHash('sha256').update(browser_file_contents).digest('hex');
                    const previous_chat_log_file_hash = cache.get(`previous_chat_log_hash_${guild_id}`);

                    if (current_chat_log_file_hash === previous_chat_log_file_hash) {
                        return;
                    }

                    cache.set(`player_chat_messages_sent_inside_scum_${guild_id}`, received_chat_messages);
                    cache.set(`previous_chat_log_hash_${guild_id}`, current_chat_log_file_hash);
                    cache.set(`initial_line_been_processed_${guild_id}`, true);
                }


                for (let i = 0; i < file_contents_steam_id_and_messages.length; i++) {
                    console.log(`Enqueue command: ${file_contents_steam_id_and_messages[i]}`);
                    await enqueueCommand(file_contents_steam_id_and_messages[i], guild_id);
                }

                // sendPlayerMessagesToDiscord(
                //     received_chat_messages,
                //     cache.get(`discord_channel_for_chat_${guild_id}`),
                //     guild_id
                // );
            });
            stream.on('error', (error) => {
                // message_logger.writeLogToAzureContainer(
                //     `ErrorLogs`,
                //     `There was a stream error when attempting to read data from FTP chat log file: ${error}`,
                //     guild_id,
                //     `${guild_id}-error-logs`
                // );
                reject(new Error(`Stream error: ${error.message}`));
            });
        });
    } catch (error) {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `There was an error when processing the SCUM chat log files: ${error}`,
        //     guild_id,
        //     `${guild_id}-error-logs`
        // );
    } finally {
        if (stream) {
            stream = null;
        }
        received_chat_messages = [];
        cache.set(`player_chat_messages_sent_inside_scum_${guild_id}`, received_chat_messages);
    }
}

/**
 * The function checkLocalServerTime runs once every minute, checking the current time relative to the time on the time clock on the target machine. Once the current time
 * fetched by the bot is 5:40 am, a warning message will be announced on the server informing users of a pending server restart in (6:00 - N), where N is the current time.
 * For example, if the current time is 5:40 am, 6:00 am - 5:40 am will result in 0:20. Therefore, the bot will announce on the server a restart in 20 minutes.
 * This occurs when the time is calculated as 20 minutes, 10 minutes, 5 minutes, and one minute.
 */
async function checkLocalServerTime(guild_id) {
    const currentDateTime = new Date();
    const current_hour = currentDateTime.getHours();
    const current_client_hours = cache.get(`restart_time_${guild_id}`);

    if (current_hour === current_client_hours) {
        const current_minute = currentDateTime.getMinutes();
        const server_restart_messages = {
            40: 'Server restart in 20 minutes',
            50: 'Server restart in 10 minutes',
            55: 'Server restart in 5 minutes',
            59: 'Server restart in 1 minute'
        };

        if (server_restart_messages[current_minute]) {
            await enqueueCommand(`#Announce ${server_restart_messages[current_minute]}`, guild_id);
        }
    }
}

/**
 * Inserts a specified steam user into the database along with their associated steam id
 * @param {any} steam_user_ids_array An array containing only 17-digit string representation of only digits 0-9
 * @param {any} steam_user_names_array An array containing only string representations of a steam username
 */
async function insertSteamUsersIntoDatabase(steam_user_ids_array, steam_user_names_array, guild_id) {
    const bot_repository = cache.get(`bot_repository_${guild_id}`);
    for (let i = 0; i < steam_user_ids_array.length; i++) {
        bot_repository.createUser(steam_user_names_array[i], steam_user_ids_array[i], guild_id);
    }
}
/**
 * verifyCallback() is a necessary function to use in all web applications when using express and passport. In this instance, verifyCallback() is the
 * function that is called internally when you are storing a user object in a session after logging in. Here are the steps in sequence:
 * 1) verifyCallback first attempts to find a user by their submitted username and password
 *  1a) If a user cannot be found, the result is null. The user is not permitted to go to any pages requiring a session with a user object.
 * 2) When the asyncronous database operation returns a user found, the properties from the returned object are stored in local variables. From there, the password
 *    submitted on the login page by the user is hashed & salted and compared with the password existing in the database.
 * 3) An 'admin' object is created to attach to the established user session. This object contains the uuid and username of the admin, so relevant details can be fetched
 *    from the database if needed.
 * 4) If the hashed and salted user submitted password matches what was found in the database, express establishes a session, stores a session key in mongodb for
 *    persistence, and attaches the admin object to the session.
 * @param {string} username
 * @param {string} password
 * @param {any} done
 */
const verifyCredentialsCallback = async (email, password, done) => {
    let bot_user_data = undefined;
    let bot_repository_instance = undefined;

    try {
        bot_repository_instance = new BotRepository();
        bot_user_data = await bot_repository_instance.getBotDataByEmail(email);

    } catch (error) {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `An error has occurred when attempting to verify that you are logged in. Please contact the server administrator with the following error: ${error}`,
        //     bot_user_data.guild_id,
        //     `${bot_user_data.guild_id}-error-logs`
        // );
        // return done(null, false);
    }
    if (!bot_user_data) {
        // message_logger.writeLogToAzureContainer(
        //     `InfoLogs`,
        //     `No user with this log in information exists`,
        //     bot_user_data.guild_id,
        //     `${bot_user_data.guild_id}-info-logs`
        // )
        // return done(null, false);
    }

    bot_repository_instance = new BotRepository(bot_user_data.guild_id);

    const bot_user_email = bot_user_data.bot_email;
    const bot_user_username = bot_user_data.bot_username;
    const bot_user_password = bot_user_data.bot_password;
    const bot_user_salt = bot_user_data.bot_salt;
    const bot_user_guild_id = bot_user_data.guild_id;
    const bot_user_ftp_server_ipv4 = bot_user_data.ftp_server_ip;
    const bot_user_ftp_server_port = bot_user_data.ftp_server_port;
    const bot_user_ftp_server_username = bot_user_data.ftp_server_username;
    const bot_user_ftp_server_password = bot_user_data.ftp_server_password;
    const bot_user_game_server_ipv4 = bot_user_data.game_server_ipv4_address;
    const bot_user_game_server_port = bot_user_data.game_server_port;
    const bot_user_ingame_chat_channel_id = bot_user_data.scum_ingame_chat_channel_id;
    const bot_user_ingame_logins_channel_id = bot_user_data.scum_ingame_logins_channel_id;
    const bot_user_new_player_joins_channel_id = bot_user_data.scum_new_player_joins_channel_id;
    const bot_user_battlemetrics_channel_id = bot_user_data.scum_battlemetrics_server_id;
    const bot_user_server_info_channel_id = bot_user_data.scum_server_info_channel_id;
    const bot_user_spawn_x_coordinate = bot_user_data.x_coordinate;
    const bot_user_spawn_y_coordinate = bot_user_data.y_coordinate;
    const bot_user_spawn_z_coordinate = bot_user_data.z_coordinate;

    const valid_user_account = validatePassword(password, bot_user_password, bot_user_salt);

    const user = {
        username: bot_user_username,
        email: bot_user_email,
        guild_id: bot_user_guild_id,
        ftp_server_ip: bot_user_ftp_server_ipv4,
        ftp_server_port: bot_user_ftp_server_port,
        ftp_server_username: bot_user_ftp_server_username,
        ftp_server_password: bot_user_ftp_server_password,
        game_server_ipv4_address: bot_user_game_server_ipv4,
        game_server_port: bot_user_game_server_port,
        scum_ingame_chat_channel_id: bot_user_ingame_chat_channel_id,
        scum_ingame_logins_channel_id: bot_user_ingame_logins_channel_id,
        scum_new_player_joins_channel_id: bot_user_new_player_joins_channel_id,
        scum_battlemetrics_server_id: bot_user_battlemetrics_channel_id,
        scum_server_info_channel_id: bot_user_server_info_channel_id,
        x_coordinate: bot_user_spawn_x_coordinate,
        y_coordinate: bot_user_spawn_y_coordinate,
        z_coordinate: bot_user_spawn_z_coordinate,
    };

    // message_logger.writeLogToAzureContainer(
    //     `InfoLogs`,
    //     `The user with guild id ${bot_user_guild_id} with username ${bot_user_username} has just logged in`,
    //     `${bot_user_guild_id}`,
    //     `${bot_user_guild_id}-info-logs`
    // );

    if (valid_user_account) {
        cache.set(`bot_repository_${bot_user_data.guild_id}`, new BotRepository(bot_user_data.guild_id));
        return done(null, user);
    } else {
        return done(null, false);
    }
}

// view engine setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
expressServer.set('views', path.join(__dirname, 'views'));
expressServer.set('view engine', 'pug');

expressServer.use(logger('dev'));
expressServer.use(express.json());
expressServer.use(express.urlencoded({ extended: true }));
expressServer.use(cookieParser());
expressServer.use(express.static(path.join(__dirname, 'public')));

expressServer.use('/', indexRouter);
expressServer.use('/admin', adminRouter);
expressServer.use('/api/', apiExecutableRecompilation);

const web_socket_server = http.createServer(expressServer);

const web_socket_server_instance = new WebSocketServer({
    noServer: true
});

web_socket_server.on('upgrade', (request, socket, head) => {
    if (request.headers.upgrade === 'websocket') {
        web_socket_server_instance.handleUpgrade(request, socket, head, (websocket) => {
            web_socket_server_instance.emit('connection', websocket, request);
        });
    } else {
        socket.destroy();
    }
});

web_socket_server_instance.on('connection', function(websocket, request) {
    console.log("Websocket connection established");
    const queryParameters = new URL(request.url, `http://${request.headers.host}`).searchParams;
    const websocket_id = queryParameters.get('websocket_id');
    websocket.id = websocket_id;

    cache.set(`websocket_${websocket_id}`, websocket);
    cache.set(`websocket_id_${websocket_id}`, websocket_id);
    cache.set(`bot_repository_${websocket_id}`, new BotRepository(websocket_id));

    websocket.on('message', async function(message) {
        let parsedWebsocketMessage = '';
        console.log('Websocket message');

        try {
            parsedWebsocketMessage = JSON.parse(message);
        } catch (error) {
            console.error(`Failed to parse Websocket payload as JSON: ${error}`);
        }

        if (parsedWebsocketMessage.action === "statusUpdate") {

            console.log('Websocket message stuff');

            const json_message_guild_id = parsedWebsocketMessage.guild_id;
            const json_message_ftp_server_data = parsedWebsocketMessage.ftp_server_data;
            const json_message_iso8601_time = parsedWebsocketMessage.localTime;

            const current_date_hours = new Date(json_message_iso8601_time).getHours();

            cache.set(`restart_time_${json_message_guild_id}`, current_date_hours);

            const ftp_client = await establishFtpConnectionToGPortal(json_message_guild_id, json_message_ftp_server_data);

            if (ftp_client) {
                readAndFormatGportalFtpServerChatLog(json_message_guild_id, ftp_client);

                readAndFormatGportalFtpServerLoginLog(cache.get(`bot_repository_${json_message_guild_id}`), json_message_guild_id, ftp_client);

                checkLocalServerTime(json_message_guild_id);

                botConnectedToGameServer(json_message_guild_id);
            }
        }
    });

    websocket.on('error', function(error) {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `There was an error when attempting to establish a web socket connection to the server: ${error}`,
        //     websocket.id,
        //     `${websocket_id}-error-logs`
        // );
    });

    websocket.on('close', function() {
        cache.delete(`websocket_${websocket_id}`);
        // message_logger.writeLogToAzureContainer(
        //     `InfoLogs`,
        //     `The websocket connection ${websocket.id} was closed`,
        //     websocket.id,
        //     `${websocket.id}-info-logs`
        // );
    });
});

expressServer.post('/login', passport.authenticate('local', {
    successRedirect: 'admin/login-success',
    failureRedirect: 'login-failure'
}));

expressServer.get('/login-failure', function (request, response, next) {
    response.render('login', {
        title: "Invalid login",
        show_error_modal: true,
        alert_title: `Error logging in`,
        alert_description: `There was an error when attempting to log in to your account. Please check your account credentials and attempt to log in again. Feel free to email the site administrator using the email account at the bottom of the page`
    });
});

const passportLoginStrategy = new LocalStrategy({
    usernameField: "email",
    passwordField: "password"
}, verifyCredentialsCallback);

passport.use(passportLoginStrategy);

passport.serializeUser(function (user, done) {
    done(null, user.guild_id);
});

passport.deserializeUser(async (guildId, done) => {
    try {
        let bot_repository_instance = cache.get(`bot_repository_${guildId}`);
        if (!bot_repository_instance) {
            cache.set(`bot_repository_${guildId}`, new BotRepository(guildId));
            bot_repository_instance = cache.get(`bot_repository_${guildId}`);
        }
        const repository_user = await bot_repository_instance.getBotDataByGuildId(guildId);

        if (repository_user) {
            // User data found in repository, store in cache and return
            return done(null, repository_user);
        } else {
            // User not found in repository, return false
            return done(null, false);
        }
    } catch (error) {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `There was an error when attempting to deserialize the user object for guild id: ${guildId}`,
        //     guildId,
        //     `${guildId}`
        // );
        return done(error, null);
    }
});

/**
 * Creates a 404 error when the application tries to navigate to a non-existent page.
 */
expressServer.use(function (req, res, next) {
    next(createError(404));
});

web_socket_server.listen(process.env.port, function () {
    console.log(`Server is running on port ${process.env.port}`);
});

// error handler
expressServer.use(function (err, req, res, next) {
    // set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};

    // render the error page
    res.status(err.status || 500);
    res.render('error');
});

function botConnectedToGameServer(guild_id) {
    const discord_channel_for_server_online = cache.get(`discord_channel_for_server_online_${guild_id}`);

    const embedded_message = new EmbedBuilder()
        .setColor(0x299bcc)
        .setTitle(`Bot connected to game server`)
        .setThumbnail(`https://i.imgur.com/dYtjF3w.png`)
        .setDescription(`The bot is online and connected to your SCUM game server`)
        .setTimestamp()
        .setFooter({text: 'Scum Monitor Man', iconURL: 'https://i.imgur.com/dYtjF3w.png'});
    discord_channel_for_server_online.send({ embeds: [embedded_message] });
}

function sendPlayerMessagesToDiscord(scum_game_chat_messages, discord_channel, guild_id) {
    if (!scum_game_chat_messages) {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `The in-game chat messages on your scum server cannot be fetched`,
        //     guild_id,
        //     `${guild_id}-error-logs`
        // );
        return;
    };

    if (!discord_channel) {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `The Discord channel for logging player chat messages could not be fetched`,
        //     guild_id,
        //     `${guild_id}-error-logs`
        // );
        return;
    };

    for (let i = 0; i < scum_game_chat_messages.length; i++) {
        if (typeof scum_game_chat_messages[i] === 'string' && scum_game_chat_messages[i].trim() && !scum_game_chat_messages.includes(`Game version:`)) {
            const embedded_message = new EmbedBuilder()
                .setColor(0x299bcc)
                .setTitle('In game chat')
                .setThumbnail('https://i.imgur.com/dYtjF3w.png')
                .setDescription(scum_game_chat_messages[i])
                .setTimestamp()
                .setFooter({ text: 'Scum Monitor Man', iconURL: 'https://i.imgur.com/dYtjF3w.png' });
            discord_channel.send({ embeds: [embedded_message] });
        }
    }
}

function isValidMessage(message) {
    const validMessagePattern = /^[a-zA-Z0-9()\[\]'":/.,{} ]+$/;
    return validMessagePattern.test(message);
}

async function sendPlayerLoginMessagesToDiscord(scum_game_login_messages, discord_channel, guild_id) {
    if (!scum_game_login_messages) {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `The in-game scum log in messages could not be fetched`,
        //     guild_id,
        //     `${guild_id}-error-logs`
        // );
        return;
    };

    if (!discord_channel) {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `The discord channel for logging server log in messages could not be fetched`,
        //     guild_id,
        //     `${guild_id}-error-logs`
        // );
        return;
    };

    if (!scum_game_login_messages) {
        return;
    }

    for (let i = 0; i < scum_game_login_messages.length; i++) {
        if (typeof scum_game_login_messages[i] === 'string' && scum_game_login_messages[i].trim() && !scum_game_login_messages.includes(`Game version:`)) {
            if (!isValidMessage(scum_game_login_messages[i])) {
                continue;
            }
            let user_logged_in_or_out = undefined;
            let x_coordinate = undefined;
            let y_coordinate = undefined;
            let z_coordinate = undefined;

            const normalized_login_message = scum_game_login_messages[i].replace(/'/g, '');

            if (logged_in_at_regex.test(normalized_login_message)) {
                user_logged_in_or_out = "logged in";
            } else if (logged_out_at_regex.test(normalized_login_message)) {
                user_logged_in_or_out = "logged out";
            }

            const parts_of_string = normalized_login_message.split(" ");
            const timestamp = parts_of_string[0];
            const ip_address = parts_of_string[1];

            const steam_id_and_username = parts_of_string[2].split(":");
            const steam_id = steam_id_and_username[0];
            const username = steam_id_and_username[1];

            const login_coordinates = normalized_login_message.split("at: ")[1];

            if (login_coordinates) {
                const coordinates = login_coordinates.match(coordinate_regex);
                x_coordinate = coordinates[1];
                y_coordinate = coordinates[2];
                z_coordinate = coordinates[3];
            }

            if (user_logged_in_or_out && x_coordinate && y_coordinate && z_coordinate
                && timestamp && ip_address && steam_id && username) {

                const embedded_message = new EmbedBuilder()
                    .setColor(0x299bcc)
                    .setTitle(`${username} ${user_logged_in_or_out}`)
                    .setThumbnail('https://i.imgur.com/dYtjF3w.png')
                    .addFields(
                        {name: "Timestamp:", value: timestamp},
                        {name: "Ip address:", value: ip_address},
                        {name: "Steam id:", value: steam_id},
                        {name: "Scum username:", value: username},
                        {name: "User action", value: user_logged_in_or_out},
                        {name: "X coordinate", value: x_coordinate},
                        {name: "Y coordinate", value: y_coordinate},
                        {name: "Z coordinate", value: z_coordinate}
                    )
                    .setDescription(`${normalized_login_message}`)
                    .setTimestamp()
                    .setFooter({ text: 'Scum Monitor Man', iconURL: 'https://i.imgur.com/dYtjF3w.png' });
                discord_channel.send({ embeds: [embedded_message] });
            }
        }
    }
}


async function sendNewPlayerLoginMessagesToDiscord(user_steam_id, discord_channel, guild_id) {
    if (!discord_channel) {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `The discord channel for new player log in messages could not be fetched`,
        //     guild_id,
        //     `${guild_id}-error-logs`
        // );
        return;
    };

    steam_web_api_player_info.setPlayerSteamId(user_steam_id);
    const player_steam_info = await steam_web_api_player_info.fetchJsonApiDataFromSteamWebApi();
    const player_steam_data = player_steam_info.response.players[0];
        const embedded_message = new EmbedBuilder()
            .setColor(0x299bcc)
            .setTitle('SCUM new player login information')
            .setThumbnail('https://i.imgur.com/dYtjF3w.png')
            .addFields(
                {name:"Steam id",value:player_steam_data.steamid,inline:true},
                {name:"Steam name",value:player_steam_data.personaname,inline:true},
                {name:"Profile Url",value:player_steam_data.profileurl,inline:true},
            )
            .setTimestamp()
            .setFooter({ text: 'Scum Monitor Man', iconURL: 'https://i.imgur.com/dYtjF3w.png' });
            discord_channel.send({ embeds: [embedded_message] });
}

function checkIfGameServerOnline(bot_status, guild_id, ftp_server_data, game_server_data) {
    const websocket = cache.get(`websocket_${guild_id}`);

    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
            action: `${bot_status}`,
            guild_id: guild_id,
            game_server_data: game_server_data,
            ftp_server_data: ftp_server_data,
        }));
    } else {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `The websocket to enable or disable the bot either does not exist or is not open`,
        //     `${guild_id}`,
        //     `${guild_id}-error-logs`
        // );
    }
}

async function enableBot(guild_id) {
    try {
        let bot_repository_instance = cache.get(`bot_repository_${guild_id}`);

        if (!(bot_repository_instance)) {
            cache.set(`bot_repository_${guild_id}`, new BotRepository(guild_id));
            bot_repository_instance = cache.get(`bot_repository_${guild_id}`);
        }

        const user_data = await bot_repository_instance.getBotDataByGuildId(guild_id);
        if (user_data) {
            const ftp_server_data = {
                ftp_server_ip: user_data.ftp_server_ip,
                ftp_server_username: user_data.ftp_server_username,
                ftp_server_password: user_data.ftp_server_password,
                ftp_server_port: user_data.ftp_server_port
            };

            const game_server_data = {
                game_server_ipv4: user_data.game_server_ipv4_address,
                game_server_port: user_data.game_server_port
            };

            const user_command_queue = new Queue();
            cache.set(`user_command_queue_${guild_id}`, user_command_queue);
            checkIfGameServerOnline(`enable`, guild_id, ftp_server_data, game_server_data);
        }
    } catch (error) {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `There was an error when attempting to initialize the check to see if the SCUM game server is online`,
        //     `${guild_id}`,
        //     `${guild_id}-error-logs`
        // );
        return;
    }
}

/**
* When the discord API triggers the interactionCreate event, an asynchronous function is executed with the interaction passed in as a parameter value.
* If the interaction is not a command, the function does not continue executing.
* @param {any} interaction
* @returns ceases execution of the function if the interaction is not a command, if the user sent the message in the wrong channel, or if the user cannot use this command
*/

client_instance.on('interactionCreate', async (interaction) => {
    const guild_id = interaction.guild.id;
    const bot_id = interaction.client.user.id;

    if (interaction.isButton()) {
        if (interaction.customId === `reinitializebotbutton`) {
            try {
                await registerInitialSetupCommands(bot_token, bot_id, guild_id);
                if (!(cache.get(`bot_repository_${guild_id}`))) {
                    cache.set(`bot_repository_${guild_id}`, new BotRepository(guild_id));
                }

                const bot_repository_instance = cache.get(`bot_repository_${guild_id}`);
                const bot_discord_information = await bot_repository_instance.getBotDataByGuildId(guild_id);

                if (bot_discord_information) {
                    const discord_channel_id_for_chat = bot_discord_information.scum_ingame_chat_channel_id;
                    const discord_channel_id_for_logins = bot_discord_information.scum_ingame_logins_channel_id;
                    const discord_channel_id_for_new_player_joins = bot_discord_information.scum_new_player_joins_channel_id;
                    const discord_channel_id_for_server_info_button = bot_discord_information.scum_server_info_channel_id;
                    const discord_channel_id_for_server_online = bot_discord_information.scum_server_online_channel_id;
                    const discord_channel_id_for_bot_commands = bot_discord_information.scum_bot_commands_channel_id;

                    const battlemetrics_server_id = bot_discord_information.scum_battlemetrics_server_id;

                    const teleport_command_prefix = bot_discord_information.command_prefix;
                    const teleport_command_x_coordinate = bot_discord_information.x_coordinate;
                    const teleport_command_y_coordinate = bot_discord_information.y_coordinate;
                    const teleport_command_z_coordinate = bot_discord_information.z_coordinate;

                    if (battlemetrics_server_id) {
                        const battlemetrics_server_info_instance = new ServerInfoCommand(battlemetrics_server_id);
                        cache.set(`battlemetrics_server_info_instance_${guild_id}`, battlemetrics_server_info_instance);
                    }
                    if (discord_channel_id_for_chat) {
                        const discord_channel_for_chat = interaction.guild.channels.cache.get(discord_channel_id_for_chat);
                        cache.set(`discord_channel_for_chat_${guild_id}`, discord_channel_for_chat);
                    }
                    if (discord_channel_id_for_logins) {
                        const discord_channel_for_logins = interaction.guild.channels.cache.get(discord_channel_id_for_logins);
                        cache.set(`discord_channel_for_logins_${guild_id}`, discord_channel_for_logins);
                    }
                    if (discord_channel_id_for_new_player_joins) {
                        const discord_channel_for_new_joins = interaction.guild.channels.cache.get(discord_channel_id_for_new_player_joins);
                        cache.set(`discord_channel_for_new_joins_${guild_id}`, discord_channel_for_new_joins);
                    }
                    if (discord_channel_id_for_server_info_button) {
                        const discord_channel_for_server_info = interaction.guild.channels.cache.get(discord_channel_id_for_server_info_button);
                        cache.set(`discord_channel_for_server_info_${guild_id}`, discord_channel_for_server_info);
                    }
                    if (discord_channel_id_for_server_online) {
                        const discord_channel_for_server_online = interaction.guild.channels.cache.get(discord_channel_id_for_server_online);
                        cache.set(`discord_channel_for_server_online_${guild_id}`, discord_channel_for_server_online);
                    }
                    if (discord_channel_id_for_bot_commands) {
                        const discord_channel_for_bot_commands = interaction.guild.channels.cache.get(discord_channel_id_for_bot_commands);
                        cache.set(`discord_channel_for_bot_commands_${guild_id}`, discord_channel_for_bot_commands);
                    }
                    cache.set(`teleport_command_prefix_${guild_id}`, teleport_command_prefix);
                    cache.set(`teleport_command_x_coordinate_${guild_id}`, teleport_command_x_coordinate);
                    cache.set(`teleport_command_y_coordinate_${guild_id}`, teleport_command_y_coordinate);
                    cache.set(`teleport_command_z_coordinate_${guild_id}`, teleport_command_z_coordinate);
                    }
                await interaction.reply({ content: `Your SCUM bot has been reset`, ephemeral: true });
            } catch (error) {
                // message_logger.writeLogToAzureContainer(
                //     `ErrorLogs`,
                //     `There was an error when registering initial bot set up commands and creating the Discord bot category and text channels: ${error}`,
                //     `${guild_id}`,
                //     `${guild_id}-error-logs`
                // )
                throw new Error(error);
            }
        }
        if (interaction.customId === `enablebotbutton`) {
            try {
                let bot_repository_instance = cache.get(`bot_repository_${guild_id}`);
                if (!bot_repository_instance) {
                    bot_repository_instance = new BotRepository(guild_id);
                }
                const bot_discord_information = await bot_repository_instance.getBotDataByGuildId(guild_id);

                if (bot_discord_information) {
                    const discord_channel_id_for_chat = bot_discord_information.scum_ingame_chat_channel_id;
                    const discord_channel_id_for_logins = bot_discord_information.scum_ingame_logins_channel_id;
                    const discord_channel_id_for_new_player_joins = bot_discord_information.scum_new_player_joins_channel_id;
                    const discord_channel_id_for_server_info_button = bot_discord_information.scum_server_info_channel_id;
                    const discord_channel_id_for_server_online = bot_discord_information.scum_server_online_channel_id;
                    const discord_channel_id_for_bot_commands = bot_discord_information.scum_bot_commands_channel_id;

                    const battlemetrics_server_id = bot_discord_information.scum_battlemetrics_server_id;

                    const teleport_command_prefix = bot_discord_information.command_prefix;
                    const teleport_command_x_coordinate = bot_discord_information.x_coordinate;
                    const teleport_command_y_coordinate = bot_discord_information.y_coordinate;
                    const teleport_command_z_coordinate = bot_discord_information.z_coordinate;

                    if (battlemetrics_server_id) {
                        const battlemetrics_server_info_instance = new ServerInfoCommand(battlemetrics_server_id);
                        cache.set(`battlemetrics_server_info_instance_${guild_id}`, battlemetrics_server_info_instance);
                    }
                    if (discord_channel_id_for_chat) {
                        const discord_channel_for_chat = interaction.guild.channels.cache.get(discord_channel_id_for_chat);
                        cache.set(`discord_channel_for_chat_${guild_id}`, discord_channel_for_chat);
                    }
                    if (discord_channel_id_for_logins) {
                        const discord_channel_for_logins = interaction.guild.channels.cache.get(discord_channel_id_for_logins);
                        cache.set(`discord_channel_for_logins_${guild_id}`, discord_channel_for_logins);
                    }
                    if (discord_channel_id_for_new_player_joins) {
                        const discord_channel_for_new_joins = interaction.guild.channels.cache.get(discord_channel_id_for_new_player_joins);
                        cache.set(`discord_channel_for_new_joins_${guild_id}`, discord_channel_for_new_joins);
                    }
                    if (discord_channel_id_for_server_info_button) {
                        const discord_channel_for_server_info = interaction.guild.channels.cache.get(discord_channel_id_for_server_info_button);
                        cache.set(`discord_channel_for_server_info_${guild_id}`, discord_channel_for_server_info);
                    }
                    if (discord_channel_id_for_server_online) {
                        const discord_channel_for_server_online = interaction.guild.channels.cache.get(discord_channel_id_for_server_online);
                        cache.set(`discord_channel_for_server_online_${guild_id}`, discord_channel_for_server_online);
                    }
                    if (discord_channel_id_for_bot_commands) {
                        const discord_channel_for_bot_commands = interaction.guild.channels.cache.get(discord_channel_id_for_bot_commands);
                        cache.set(`discord_channel_for_bot_commands_${guild_id}`, discord_channel_for_bot_commands);
                    }
                    cache.set(`teleport_command_prefix_${guild_id}`, teleport_command_prefix);
                    cache.set(`teleport_command_x_coordinate_${guild_id}`, teleport_command_x_coordinate);
                    cache.set(`teleport_command_y_coordinate_${guild_id}`, teleport_command_y_coordinate);
                    cache.set(`teleport_command_z_coordinate_${guild_id}`, teleport_command_z_coordinate);

                    await enableBot(guild_id);

                    await interaction.reply({ content: `Your SCUM server bot has been enabled`, ephemeral: true });
                } else {
                    await interaction.reply({ content: `Your SCUm server bot cannot find your user profile. Please ask the bot developer to register an account for you`, ephemeral: true});
                }
            } catch (error) {
                await interaction.reply(`There was an error when attempting to enable your SCUM bot. Please try again or contact the bot administrator: ${error}`);
                // message_logger.writeLogToAzureContainer(
                //     `ErrorLogs`,
                //     `There was an error when creating the Discord bot category and text channels: ${error}`,
                //     `${guild_id}`,
                //     `${guild_id}-error-logs`
                // );
                return;
            }
        }

        if (interaction.customId === `disablebotbutton`) {
            try {
                if (cache.get(`discord_channel_for_chat_${guild_id}`)) {
                    cache.delete(`discord_channel_for_chat_${guild_id}`);
                }
                if (cache.get(`discord_channel_for_logins_${guild_id}`)) {
                    cache.delete(`discord_channel_for_logins_${guild_id}`);
                }
                if (cache.get(`discord_channel_for_new_joins_${guild_id}`)) {
                    cache.delete(`discord_channel_for_new_joins_${guild_id}`)
                }
                if (cache.get(`discord_channel_for_server_info_${guild_id}`)) {
                    cache.delete(`discord_channel_for_server_info_${guild_id}`);
                }
                if (cache.get(`discord_channel_for_server_online_${guild_id}`)) {
                    cache.delete(`discord_channel_for_server_online_${guild_id}`);
                }
                if (cache.get(`discord_channel_for_bot_commands_${guild_id}`)) {
                    cache.delete(`discord_channel_for_bot_commands_${guild_id}`);
                }
                if (cache.get(`teleport_command_prefix_${guild_id}`)) {
                    cache.delete(`teleport_command_prefix_${guild_id}`);
                }
                if (cache.get(`teleport_command_x_coordinate_${guild_id}`)) {
                    cache.delete(`teleport_command_x_coordinate_${guild_id}`);
                }
                if (cache.get(`teleport_command_y_coordinate_${guild_id}`)) {
                    cache.delete(`teleport_command_y_coordinate_${guild_id}`);
                }
                if (cache.get(`teleport_command_z_coordinate_${guild_id}`)) {
                    cache.delete(`teleport_command_z_coordinate_${guild_id}`);
                }

                checkIfGameServerOnline(`disable`, undefined, undefined, undefined);

                await interaction.reply(`Your SCUM bot has been disabled. Remember to re-enable the bot by clicking the 'Enable bot' button when you want to use the bot`);
            } catch (error) {
                await interaction.reply(`There was an error when attempting to disable your SCUM bot. Please try again or contact the bot administrator: ${error}`);
            }
        }

        if (interaction.customId === `setupdiscordchannelids`) {
            try {
                const setupChannelsCommand = client_instance.discord_commands.get(`setupchannels`);
                await setupChannelsCommand.execute(interaction)
            } catch (error) {
                await interaction.reply(`There was an error when attempting to show the set up Discord channel form. Please first restart your bot. If that does not work, contact the bot administrator and inform them of the following error or try again: ${error}`);
            }
        }

        if (interaction.customId === `setupftpserverdata`) {
            try {
                const setupFtpSeverCommand = client_instance.discord_commands.get(`setupftpserver`);
                await setupFtpSeverCommand.execute(interaction);
            } catch (error) {
                await interaction.reply(`There was an error when attempting to show the set up FTP data form. Please first restart your bot. If that does not work, contact the bot administrator and inform them of the following error or try again: ${error}`);
            }
        }

        if (interaction.customId === `setupwebsiteuser`) {
            try {
                const setupFtpSeverCommand = client_instance.discord_commands.get(`setupuser`);
                await setupFtpSeverCommand.execute(interaction);
            } catch (error) {
                await interaction.reply(`There was an error when attempting to show the set up bot website user data form. Please first restart your bot. If that does not work, contact the bot administrator and inform them of the following error or try again: ${error}`);
            }
        }

        if (interaction.customId === `setupgameserver`) {
            try {
                const setupFtpSeverCommand = client_instance.discord_commands.get(`setupgameserver`);
                await setupFtpSeverCommand.execute(interaction);
            } catch (error) {
                await interaction.reply(`There was an error when attempting to show the set up SCUM server data form. Please first restart your bot. If that does not work, contact the bot administrator and inform them of the following error or try again: ${error}`);
            }
        }

        if (interaction.customId === `setupuserspawn`) {
            try {
                const setupFtpSeverCommand = client_instance.discord_commands.get(`setupuserspawn`);
                await setupFtpSeverCommand.execute(interaction);
            } catch (error) {
                await interaction.reply(`There was an error when attempting to show the set up new user spawn area data form. Please first restart your bot. If that does not work, contact the bot administrator and inform them of the following error or try again: ${error}`);
            }
        }

        if (interaction.customId === `serverinformationbutton`) {
            let battlemetrics_server_info = undefined;
            try {
                battlemetrics_server_info = cache.get(`battlemetrics_server_info_instance_${interaction.guild.id}`);
            } catch (error) {
                await interaction.reply(`There was an error when attempting to find your SCUM server information. Please first restart your bot. If that does not work, contact the bot administrator and inform them of the following error: ${error}`);
                return;
            }

            if (battlemetrics_server_info) {
                const battlemetrics_server_data_object = await battlemetrics_server_info.fetchJsonApiDataFromBattlemetrics();
                const battlemetrics_server_json_data = battlemetrics_server_data_object.data.attributes;
                const battlemetrics_server_id = battlemetrics_server_json_data.id;
                const battlemetrics_server_name = battlemetrics_server_json_data.name;
                const battlemetrics_server_ip = battlemetrics_server_json_data.ip;
                const battlemetrics_server_port = battlemetrics_server_json_data.port;
                const battlemetrics_server_players = battlemetrics_server_json_data.players;
                const battlemetrics_server_max_players = battlemetrics_server_json_data.maxPlayers;
                const battlemetrics_server_rank = battlemetrics_server_json_data.rank;
                const battlemetrics_server_version = battlemetrics_server_json_data.details.version;
                const battlemetrics_server_time = battlemetrics_server_json_data.details.time;
                const embedded_message = new EmbedBuilder()
                    .setColor(0x299bcc)
                    .setTitle(`${battlemetrics_server_name}`)
                    .setThumbnail(`https://i.imgur.com/dYtjF3w.png`)
                    .addFields(
                        {name:'Server name',value:battlemetrics_server_name,inline:true},
                        {name:'Server Id',value:battlemetrics_server_id,inline:true},
                        {name:'IPv4 server address',value:battlemetrics_server_ip,inline:true},
                        {name:'Server port',value:battlemetrics_server_port.toString(),inline:true},
                        {name:'Current online players',value:String(battlemetrics_server_players),inline:true},
                        {name:'Server maximum online players',value:String(battlemetrics_server_max_players),inline:true},
                        {name:'Server ranking',value:String(battlemetrics_server_rank),inline:true},
                        {name:'Server version',value:battlemetrics_server_version,inline:true},
                        {name:'Server time',value:battlemetrics_server_time,inline:true}
                    )
                    .setTimestamp()
                    .setFooter({text:'Scum Monitor Man', iconURL: 'https://i.imgur.com/dYtjF3w.png'});

                await interaction.reply({embeds:[embedded_message], ephemeral:true});
            }
        }
    }

    if (!interaction.isCommand()) {
        return;
    }

    const command = client_instance.discord_commands.get(interaction.commandName);

    if (!command) {
        return;
    }

    if (determineIfUserCanUseCommand(interaction.member, command.authorization_role_name)) {
        await command.execute(interaction);
    } else {
        await interaction.reply({ content: `You do not have permission to execute the command ${command.data.name}. Contact the server or bot administrator if you believe this is an error` });
    }
});


/**
 * The guildCreate event is triggered when the Discord bot joins a new server
 */
client_instance.on('guildCreate', async (guild) => {
    const bot_id = client_instance.user.id;
    const guild_id = guild.id;
    cache.set(`guild_${guild_id}`, guild_id);

    try {
        let bot_repository_instance = cache.get(`bot_repository_${guild_id}`);
        if (!bot_repository_instance) {
            cache.set(`bot_repository_${guild_id}`, new BotRepository(guild_id));
            bot_repository_instance = cache.get(`bot_repository_${guild_id}`);
        }

        await registerInitialSetupCommands(bot_token, bot_id, guild_id);
        await createBotCategoryAndChannels(guild);
        const bot_discord_information = await bot_repository_instance.getBotDataByGuildId(guild_id);

        console.log(bot_discord_information);

        if (bot_discord_information) {
            const server_info_button = new ButtonBuilder()
                .setCustomId('serverinformationbutton')
                .setLabel('View server info')
                .setStyle(ButtonStyle.Success);

            const enable_bot_button = new ButtonBuilder()
                .setCustomId('enablebotbutton')
                .setLabel(`Enable bot`)
                .setStyle(ButtonStyle.Success);

            const disable_bot_button = new ButtonBuilder()
                .setCustomId('disablebotbutton')
                .setLabel(`Disable bot`)
                .setStyle(ButtonStyle.Danger);

            const reinitialize_bot_button = new ButtonBuilder()
                .setCustomId(`reinitializebotbutton`)
                .setLabel(`Restart bot`)
                .setStyle(ButtonStyle.Success);

            const setup_discord_channel_ids_button = new ButtonBuilder()
                .setCustomId(`setupdiscordchannelids`)
                .setLabel(`Register Discord channel ids`)
                .setStyle(ButtonStyle.Primary)

            const setup_ftp_server_button = new ButtonBuilder()
                .setCustomId(`setupftpserverdata`)
                .setLabel(`Register FTP data`)
                .setStyle(ButtonStyle.Primary)

            const setup_website_user_button = new ButtonBuilder()
                .setCustomId(`setupwebsiteuser`)
                .setLabel(`Register website user`)
                .setStyle(ButtonStyle.Primary)

            const setup_game_server_button = new ButtonBuilder()
                .setCustomId(`setupgameserver`)
                .setLabel(`Register SCUM game server data`)
                .setStyle(ButtonStyle.Primary)

            const setup_user_spawn_coordinates_button = new ButtonBuilder()
                .setCustomId(`setupuserspawn`)
                .setLabel(`Register user spawn coordinates`)
                .setStyle(ButtonStyle.Primary)

            const goto_bot_website_button = new ButtonBuilder()
                .setLabel(`Go to bot web portal`)
                .setURL("https://scumchatmonitorweb.azurewebsites.net")
                .setStyle(ButtonStyle.Link)

            const button_row_bot_controls = new ActionRowBuilder().addComponents(
                server_info_button,
                enable_bot_button,
                disable_bot_button,
                reinitialize_bot_button,
                goto_bot_website_button
            );

            const button_row_bot_data = new ActionRowBuilder().addComponents(
                setup_discord_channel_ids_button,
                setup_ftp_server_button,
                setup_website_user_button,
                setup_game_server_button,
                setup_user_spawn_coordinates_button
            );

            const discord_channel_id_for_chat = bot_discord_information.scum_ingame_chat_channel_id;
            const discord_channel_id_for_logins = bot_discord_information.scum_ingame_logins_channel_id;
            const discord_channel_id_for_new_player_joins = bot_discord_information.scum_new_player_joins_channel_id;
            const discord_channel_id_for_server_info_button = bot_discord_information.scum_server_info_channel_id;
            const discord_channel_id_for_server_online = bot_discord_information.scum_server_online_channel_id;
            const discord_channel_id_for_bot_commands = bot_discord_information.scum_bot_commands_channel_id;

            const battlemetrics_server_id = bot_discord_information.scum_battlemetrics_server_id;

            const teleport_command_prefix = bot_discord_information.command_prefix;
            const teleport_command_x_coordinate = bot_discord_information.x_coordinate;
            const teleport_command_y_coordinate = bot_discord_information.y_coordinate;
            const teleport_command_z_coordinate = bot_discord_information.z_coordinate;

            if (battlemetrics_server_id) {
                const battlemetrics_server_info_instance = new ServerInfoCommand(battlemetrics_server_id);
                cache.set(`battlemetrics_server_info_instance_${guild_id}`, battlemetrics_server_info_instance);
            }
            if (discord_channel_id_for_chat) {
                const discord_channel_for_chat = guild.channels.cache.get(discord_channel_id_for_chat);
                cache.set(`discord_channel_for_chat_${guild_id}`, discord_channel_for_chat);
            }
            if (discord_channel_id_for_logins) {
                const discord_channel_for_logins = guild.channels.cache.get(discord_channel_id_for_logins);
                cache.set(`discord_channel_for_logins_${guild_id}`, discord_channel_for_logins);
            }
            if (discord_channel_id_for_new_player_joins) {
                const discord_channel_for_new_joins = guild.channels.cache.get(discord_channel_id_for_new_player_joins);
                cache.set(`discord_channel_for_new_joins_${guild_id}`, discord_channel_for_new_joins);
            }
            if (discord_channel_id_for_server_info_button) {
                const discord_channel_for_server_info = guild.channels.cache.get(discord_channel_id_for_server_info_button);
                await discord_channel_for_server_info.send({
                    content: `**Bot controls:**\nClick one of the buttons below to control your bot:\n\n`+
                    `**View server info:** View information about your SCUM server\n`+
                    `**Enable bot:** Enable your bot so it starts working on your SCUM server\n`+
                    `**Disable bot:** Disable your bot so it stops working on your SCUM server\n`+
                    `**Restart bot:** Restart the bot so all functionality restarts. Useful if the bot is having problems\n`+
                    `**Go to bot web portal:** Go to your bot web portal to configure settings and add packages\n`,
                components: [button_row_bot_controls]
                });
                await discord_channel_for_server_info.send({
                    content: `**Bot setup**:\nClick one of the buttons below to configure your bot:\n\n`+
                    `**Register Discord channel ids:**  Register the Discord channel ids in this server with your bot\n`+
                    `**Register FTP data:** Register the your server host's FTP server with your bot\n`+
                    `**Register website user:** Register a website user with your bot. This will give you access to the bot web interface\n`+
                    `**Register SCUM game server data:** Register your SCUM game server data (IPv4 address and port number) with your bot\n`+
                    `**Register user spawn coordinates:** Register new user spawn coordinates with your bot\n`,
                components: [button_row_bot_data]
                });
                cache.set(`discord_channel_for_server_info_${guild_id}`, discord_channel_for_server_info);
            }
            if (discord_channel_id_for_server_online) {
                const discord_channel_for_server_online = guild.channels.cache.get(discord_channel_id_for_server_online);
                cache.set(`discord_channel_for_server_online_${guild_id}`, discord_channel_for_server_online);
            }
            if (discord_channel_id_for_bot_commands) {
                const discord_channel_for_bot_commands = guild.channels.cache.get(discord_channel_id_for_bot_commands);
                cache.set(`discord_channel_for_bot_commands_${guild_id}`, discord_channel_for_bot_commands);
            }
            cache.set(`teleport_command_prefix_${guild_id}`, teleport_command_prefix);
            cache.set(`teleport_command_x_coordinate_${guild_id}`, teleport_command_x_coordinate);
            cache.set(`teleport_command_y_coordinate_${guild_id}`, teleport_command_y_coordinate);
            cache.set(`teleport_command_z_coordinate_${guild_id}`, teleport_command_z_coordinate);
        }
    } catch (error) {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `There was an error when registering initial bot set up commands and creating the Discord bot category, buttons, and text channels: ${error}`,
        //     `${guild_id}`,
        //     `${guild_id}-error-logs`
        // )
        return;
    }
});

myEmitter.on('newUserJoinedServer', (steam_id, discord_channel_for_new_joins, guild_id) => {
    sendNewPlayerLoginMessagesToDiscord(steam_id, discord_channel_for_new_joins, guild_id)
});

client_instance.on(Events.InteractionCreate, async interaction => {
    if (interaction.isModalSubmit()) {

        const guild_id = interaction.guild.id

        if (interaction.customId === 'userDataInputModal') {
            const user_username = interaction.fields.getTextInputValue('usernameInput');
            const user_email = interaction.fields.getTextInputValue('emailInput');
            const user_password_hash_object = hashPassword(interaction.fields.getTextInputValue('passwordInput'));
            const guild_id = interaction.guildId;

            const bot_information = {
                bot_username: user_username,
                bot_email: user_email,
                bot_password_hash: user_password_hash_object.hash,
                bot_password_salt: user_password_hash_object.salt,
                bot_id: bot_token,
                guild_id: guild_id
            }

            try {
                const bot_repository_instance = cache.get(`bot_repository_${guild_id}`);
                await bot_repository_instance.createBot(bot_information);
                await bot_repository_instance.createOrUpdateUser(bot_information.bot_email);
            } catch (error) {
                throw new Error(`There was an error when attempting to create a bot for you. Please inform the server administrator of this error: ${error}`);
            }
        }

        else if (interaction.customId === `userSpawnCoordsInputModal`) {
            const teleport_prefix = "#Teleport";
            const x_coordinate = interaction.fields.getTextInputValue(`xCoordinateInput`);
            const y_coordinate = interaction.fields.getTextInputValue(`yCoordinateInput`);
            const z_coordinate = interaction.fields.getTextInputValue(`zCoordinateInput`);

            const player_spawn_coordinate_zone_data = {
                guild_id: guild_id,
                command_prefix: teleport_prefix,
                x_coordinate: x_coordinate,
                y_coordinate: y_coordinate,
                z_coordinate: z_coordinate
            }

            try {
                const bot_repository_instance = cache.get(`bot_repository_${guild_id}`);
                await bot_repository_instance.createBotTeleportNewPlayerCoordinates(player_spawn_coordinate_zone_data);
            } catch (error) {
                throw new Error(`There was an error when attempting to update your bot with new player spawn coordinates. Please inform the server administrator of this error: ${error}`);
            }
        }

        else if (interaction.customId === `battlemetricsServerIdModal`) {
            const battlemetrics_server_id = interaction.fields.getTextInputValue(`battlemetricsServerInput`);
            const battlemetrics_server_info_instance = new ServerInfoCommand(battlemetrics_server_id);
            cache.set(`battlemetrics_server_info_instance_${guild_id}`, battlemetrics_server_info_instance);

            const battlemetrics_server_info = cache.get(`battlemetrics_server_info_instance_${guild_id}`);

            if (!battlemetrics_server_info) {
                cache.set(`battlemetrics_server_info_instance_${guild_id}`, battlemetrics_server_info_instance);
            }

            const server_battlemetrics_data = {
                discord_battlemetrics_server_id: battlemetrics_server_id,
                guild_id: guild_id
            }

            try {
                const bot_repository_instance = cache.get(`bot_repository_${guild_id}`);
                await bot_repository_instance.createBotBattlemetricsData(server_battlemetrics_data);
            } catch (error) {
                throw new Error(`There was an error when attempting to update your bot with Discord channel data. Please inform the server administrator of this error: ${error}`);
            }
        }

        else if (interaction.customId === `gameServerInputModal`) {
            const ipv4_address = interaction.fields.getTextInputValue(`ipv4AddressInput`);
            const port = interaction.fields.getTextInputValue(`portInput`);

            const game_server_data = {
                game_server_hostname_input: ipv4_address,
                game_server_port_input: port,
                guild_id: guild_id
            }

            try {
                const bot_repository_instance = cache.get(`bot_repository_${guild_id}`);
                await bot_repository_instance.createBotGameServerData(game_server_data);
            } catch (error) {
                throw new Error(`There was an error when attempting to update your bot with game server data. Please inform the server administrator of this error: ${error}`);
            }
        }
        else if (interaction.customId === `ftpServerInputModal`) {
            const ipv4_address = interaction.fields.getTextInputValue(`ipv4AddressInput`);
            const port = interaction.fields.getTextInputValue(`portInput`);
            const username = interaction.fields.getTextInputValue(`usernameInput`);
            const password = interaction.fields.getTextInputValue(`passwordInput`);

            const ftp_server_data = {
                ftp_server_hostname: ipv4_address,
                ftp_server_port: port,
                ftp_server_username: username,
                ftp_server_password: password,
                guild_id: guild_id
            }

            try {
                const bot_repository_instance = cache.get(`bot_repository_${guild_id}`);
                await bot_repository_instance.createBotFtpServerData(ftp_server_data);
            } catch (error) {
                throw new Error(`There was an error when attempting to update your bot with FTP server data. Please inform the server administrator of this error: ${error}`);
            }
        }

      if (interaction.customId === `userDataInputModal`) {
        await interaction.reply({content: `Your submission for creating new user data with your bot was successful`, ephemeral: true});
      } else if (interaction.customId === `battlemetricsServerIdModal`) {
        await interaction.reply({content: `Your submission for creating a new battlemetrics server id with your bot was successful`, ephemeral: true});
      } else if (interaction.customId === `gameServerInputModal`) {
        await interaction.reply({content: `Your submission for creating new game server data with your bot was successful`, ephemeral: true});
      } else if (interaction.customId === `ftpServerInputModal`) {
        await interaction.reply({content: `Your submission for creating new ftp server data with your bot was successful`, ephemeral: true});
      } else if (interaction.customId === `userSpawnCoordsInputModal`) {
        await interaction.reply({content: `Your submission for creating new player spawn coordinates was successful`, ephemeral: true});
      }
    }
});

client_instance.on('ready', () => {
    console.log('Bot is online!');
});

async function createBotCategoryAndChannels(guild) {
    console.log('Create bot channels and category');
    try {
        const category_creation_response = await guild.channels.create({
            name: `SCUM Chat Monitor Bot`,
            type: ChannelType.GuildCategory
        });

        const discord_channel_ids = {
            guild_id: guild.id
        };

        const channel_names = [
            "Bot commands",
            "Server chat",
            "Server logins and logouts",
            "New player joins",
            "Server info buttons",
            "Server online",
        ];

        const mongodb_channel_names = [
            "discord_bot_commands_channel_id",
            "discord_ingame_chat_channel_id",
            "discord_logins_chat_channel_id",
            "discord_new_player_chat_channel_id",
            "discord_server_info_button_channel_id",
            "discord_server_online_channel_id"
        ];

        for (let i = 0; i < channel_names.length; i++) {
            const channel_name = channel_names[i];
            if (channel_name) {
                const created_channel = await guild.channels.create({
                    name: `${channel_name}`,
                    type: ChannelType.GuildText,
                    parent: category_creation_response.id
                });
                const mongodb_channel_name = mongodb_channel_names[i];
                discord_channel_ids[mongodb_channel_name] = created_channel.id;
            }
        }
        const bot_repository_instance = await cache.get(`bot_repository_${guild.id}`);
        bot_repository_instance.createBotDiscordData(discord_channel_ids);
    } catch (error) {
        console.error(`There was an error when setting up the bot channels. Please inform the server administrator of this error: ${error}`);
        throw new Error(`There was an error when setting up the bot channels. Please inform the server administrator of this error: ${error}`);
    }
}

async function registerInitialSetupCommands(bot_token, bot_id, guild_id) {
    const commands_folder_path = path.join(__dirname, "./commands/discordcommands");
    const filtered_command_files = fs
        .readdirSync(commands_folder_path)
        .filter((file) => file !== "deploy-commands.js");
    client_instance.discord_commands = new Collection();

    const commands = [];

    const initial_bot_commands = [`setupuserspawn`, `setupuser`, `setupchannels`, `setupgameserver`, `setupchannels`, `setupftpserver`, `setupbotcommands`];

    for (const command_file of filtered_command_files) {
        const command_file_path = path.join(commands_folder_path, command_file);
        const command_file_url = pathToFileURL(command_file_path).href;
        const command_import = await import(command_file_url);
        const command_default_object = command_import.default();

        if (initial_bot_commands.includes(command_default_object.data.name)) {
            commands.push(command_default_object.data);
            client_instance.discord_commands.set(command_default_object.data.name, command_default_object);
        }
    }

    if (bot_token && bot_id && guild_id) {
        const rest = new REST({ version: '10' }).setToken(bot_token)

        rest.put(Routes.applicationGuildCommands(bot_id, guild_id), {
            body: commands
        }).then(() => {
            // message_logger.writeLogToAzureContainer(
            //     `InfoLogs`,
            //     `Successfully initialized the application seutp commands for ${bot_id} in the guild ${guild_id}`,
            //     guild_id,
            //     `${guild_id}-error-logs`
            // )
        }).catch((error) => {
            // message_logger.writeLogToAzureContainer(
            //     `ErrorLogs`,
            //     `There was an error when attempting to register the initial application commands for ${bot_id} in the guild ${guild_id}: ${error}`,
            //     guild_id,
            //     `${guild_id}-error-logs`
            // )
        });
    }
}

async function enqueueCommand(user_chat_message_object, guild_id) {
    console.log(`Command has been enqueued: ${user_chat_message_object} + ${guild_id}`);
    const user_command_queue = new Queue();

    user_command_queue.enqueue(user_chat_message_object);
    await setProcessQueueMutex(user_command_queue, guild_id);
}

async function setProcessQueueMutex(user_command_queue, guild_id) {
    mutex
        .runExclusive(async () => {
            await processQueueIfNotProcessing(user_command_queue, guild_id);
        })
        .catch((error) => {
            if (error === E_CANCELED) {
                mutex.cancel();
            } else {
                console.error(`An error has occurred during execution of the mutex: ${error}`);
            }
        });
}

async function processQueueIfNotProcessing(user_command_queue, guild_id) {
    const bot_repository = cache.get(`bot_repository_${guild_id}`);
    let bot_package_items = undefined;
    let bot_item_package_cost = undefined;
    let bot_item_package = undefined;
    let teleport_coordinates = undefined;

    while (user_command_queue.size() > 0) {
        /**
         * After a command has finished execution in the queue, shift the values one spot to remove the command which has been executed. Extract the command
         * and the steam id of the user who executed the command
         */
        const user_chat_message_object = user_command_queue.dequeue();

        /*
        user_chat_message_object is a key value pair. If the value for that key is undefined, continue to the next element.
        */
        if (user_chat_message_object.value === undefined) {
            continue;
        }

        /*
        The key value pair object 'user_chat_message_object' holds the command that the user used as the value. We must fetch the value by referencing the first
        element in the value property. The value property starts with a ' character, so we take a substring of the value starting after the first character.
        Next, we have to take the key associated with the command used, which is the user's steam id
        */
        const command_name = user_chat_message_object.value[0].substring(1);
        const command_to_execute_player_steam_id = user_chat_message_object.key[0];

        /**
         * Fetch the user from the database with an id that corresponds with the one associated with the executed command. After, fetch all of properties and data from the user and command
         * that is relevant
         */
        const user_account = await bot_repository.findUserById(command_to_execute_player_steam_id);
        const user_account_balance = user_account.user_money;

        /**
         * Remove the weird (0-9{1,4}) value which is appended onto each username in the GPortal chat log.
         * The GPortal chat log generates usernames like: jacobdgraham02(102). Therefore, we will use regex to replace that with: jacobdgraham02
         */
        const client_ingame_chat_name = user_account.user_steam_name.replace(/\([0-9]{1,4}\)/g, '');

        /*
        By using a string representation of the command to execute, we will fetch the command from the MongoDB database. If the command executed in game is '/test',
        a document with the name 'test' will be searched for in MongoDB. MongoDB returns the bot_item_package as an object instead of an array of objects.
        */
        if (command_name.toString().startsWith('teleport')) {
            const teleport_command_name = command_name.toString().replace("teleport", "");
            bot_item_package = await bot_repository.getBotTeleportCommandFromName(teleport_command_name);
            teleport_coordinates = {
                name: bot_item_package.name,
                x: bot_item_package.x_coordinate,
                y: bot_item_package.y_coordinate,
                z: bot_item_package.z_coordinate,
                cost: bot_item_package.cost
            };
            await sendMessageToClient(`${client_ingame_chat_name}, you will soon be teleported to the zone ${teleport_coordinates.name}`, guild_id, command_to_execute_player_steam_id);
            await bot_repository.updateUserAccountBalance(command_to_execute_player_steam_id, -teleport_coordinates.cost);
            await teleportPlayerToLocation(teleport_coordinates, guild_id, command_to_execute_player_steam_id);
            continue;
        }

        try {
            bot_item_package = await bot_repository.getBotPackageFromName(command_name.toString());
            if (!bot_item_package) {
                await sendMessageToClient(`${client_ingame_chat_name}, this package does not exist`, guild_id, 0);
                continue;
            }
            /**
             * Open the chat menu by pressing the 'T' key. If the chat is already open, press the 'Backspace key to get rid of the hanging 'T' character
             */
            if (bot_item_package.package_items) {
                bot_package_items = bot_item_package.package_items;
                await sendCommandToClient(bot_package_items, guild_id, command_to_execute_player_steam_id);
            }
            if (bot_item_package.package_cost) {
                bot_item_package_cost = bot_item_package.package_cost;
                if (user_account_balance < bot_item_package_cost) {
                    await sendMessageToClient(`${client_ingame_chat_name}, you do not have enough money to use this command`, guild_id, command_to_execute_player_steam_id)
                    continue;
                }
                /**
                 * Subtract the balance of the package from the user's balance
                 */
                await bot_repository.updateUserAccountBalance(command_to_execute_player_steam_id, -bot_item_package_cost);
                await sendMessageToClient(`${client_ingame_chat_name}, the cost of the bot item package has been deducted from your account`, guild_id, command_to_execute_player_steam_id);
                continue;
            }
            continue;

        } catch (error) {
            await sendMessageToClient(`${client_ingame_chat_name}, this package does not exist`, guild_id, command_to_execute_player_steam_id);
            continue;
        }

        /**
         * All of the other commands just deduct money from the user account when executed. The command '!welcomepack' is special because it can be executed multiple times, increasing
         * in cost by 5000 after each execution. In the database class, there is a trigger defined for the user_welcome_pack_cost field that increments by 5000 each time it detects
         * an increment by 1 for the field 'user_welcome_pack_uses'. Each time this command is executed, we update the user welcome pack uses by one.
         */
        if (command_name === 'welcomepack') {
            const welcome_pack_uses = user_account.user_welcome_pack_uses || 0;
            const welcome_pack_cost = 1000 * (welcome_pack_uses + 1);

             if (user_account_balance < welcome_pack_cost) {
                await sendMessageToClient(
                    `${client_ingame_chat_name}, you do not have enough money to use your welcome pack again. Use the command /balance to check your balance`,
                    guild_id,
                    command_to_execute_player_steam_id);

             } else {
                await bot_repository.updateUserWelcomePackUsesByOne(user_account.user_steam_id);
                await bot_repository.updateUserAccountBalance(user_account.user_steam_id, -welcome_pack_cost);
             }
        }
    }
}

async function sendCommandToClient(bot_package_items_array, websocketId, player_steam_id) {
    const websocket = cache.get(`websocket_${websocketId}`);

    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
            action: `runCommand`,
            package_items: bot_package_items_array,
            guild_id: websocketId,
            steam_id: player_steam_id
        }));
    } else {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `The websocket to send commands to execute back to the client either does not exist or is not open`,
        //     `${websocketId}`,
        //     `${websocketId}-error-logs`
        // );
    }
}

async function teleportPlayerToLocation(coordinates, websocket_id, steam_id) {
    const websocket = cache.get(`websocket_${websocket_id}`);

    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
            action: `teleport`,
            teleport_coordinates: coordinates,
            player_steam_id: steam_id
        }));
    } else {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `The websocket to send new player join messages to execute back to the client either does not exist or is not open`,
        //     `${websocket_id}`,
        //     `${websocket_id}-error-logs`
        // )
    }
}

async function sendMessageToClient(message, websocket_id, steam_id) {
    console.log("Send message to client");
    const websocket = cache.get(`websocket_${websocket_id}`);

    const message_array = [message];

    if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
            action: `announceMessage`,
            messages: message_array,
            player_steam_id: steam_id
        }));
    } else {
        // message_logger.writeLogToAzureContainer(
        //     `ErrorLogs`,
        //     `The websocket to send messages to execute back to the client either does not exist or is not open`,
        //     `${websocket_id}`,
        //     `${websocket_id}-error-logs`
        // )
    }
}

/**
 * Bot interacts with the discord API to 'log in' and become ready to start executing commands
 */
client_instance.login(bot_token);

/**
 * When a user executes a bot command in the correct channel, this function will determine if the user is allowed to use the command.
 * This is determined by an array of values in the property 'authorization_role_name' in each of the command files.
 * @param {any} message_sender
 * @param {any} client_command_values
 * @returns
 */
function determineIfUserCanUseCommand(message_sender, client_command_values) {
    if (client_command_values.authorization_role_name === undefined) {
        return true;
    }
    return message_sender.roles.cache.some(role => client_command_values.authorization_role_name.includes(role.name));
}

export default expressServer;
