require('dotenv').config();
const readline = require('readline');

const { setupCronJob, setupBalanceCheck, setupDailyReward, setupFarmReward } = require('./cronJob');
const { getAllQueryIds, extractQueryIds } = require('./fileHandler');
const { formatDate, sleep, retry } = require('./helpers');

const {
    claimDailyReward, claimFarmReward, claimGamePoints, claimTaskReward, getBalance,
    getGameId, getTasks, getToken, getUsername, startFarmingSession, startTask//, getTribe
} = require('./api');

const { header, menu } = require('./config/view');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const JSON_FILE_NAME = process.env.JSON_FILE_NAME || 'blumAccount.json';

const MAX_DELAY_PER_TASK = parseInt(process.env.MAX_DELAY_PER_TASK) || 5;
const MIN_DELAY_PER_TASK = parseInt(process.env.MIN_DELAY_PER_TASK) || 3;

const MAX_POINT = parseInt(process.env.MAX_POINT) || 221;
const MIN_POINT = parseInt(process.env.MIN_POINT) || 197;

function askQuestion(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

let cronJobRunning = false;

(async () => {
    let choice;

    while (true) {
        if (!cronJobRunning) {
            console.clear(); header(); menu();

            choice = await askQuestion(' ? Choose: (0-6) ');

            // @MENU : (Not 0-6) - Invalid
            if (!/^[0-6]$/.test(choice)) {
                await askQuestion('\n ! Invalid choice. Press [ENTER]'); continue;
            }

            // @MENU : 0 - Exit Program
            if (choice === '0') process.exit();

            // @MENU : 1 - Add Account
            if (choice === '1') {
                console.clear(); header(parseInt(choice));

                await extractQueryIds(JSON_FILE_NAME, await askQuestion('   + Input URL: '));
                await askQuestion('\n > Process completed. Press [ENTER]');
            }

            // @MENU : 2, 3, 4, 5, 6 - Validation
            if (['2', '3', '4', '5', '6'].includes(choice)) {
                console.clear(); header(parseInt(choice));
                const queryData = getAllQueryIds(JSON_FILE_NAME);

                if (!queryData || queryData.length === 0) {
                    await askQuestion('\n ! Add account please. Press [ENTER]'); continue;
                }

                console.log('   # List of accounts:');
                queryData.forEach((account, index) => {
                    console.log(`      ${index + 1}. @${account.username}`);
                });
                console.log('\n      0. Main menu');

                const accountChoice = await askQuestion('\n   ? Choose an account: (0-' + queryData.length + ') ');

                if (accountChoice == '0') continue;

                if (!/^[0-9]\d*$/.test(accountChoice) || accountChoice < 0 || accountChoice > queryData.length) {
                    await askQuestion('\n ! Invalid choice! [ENTER]');
                    continue;
                }

                const queries = queryData[accountChoice - 1].query_id;
                token = await retry(() => getToken(queries), 'getToken');
                const username = await retry(() => getUsername(token), 'getUsername');
                const balance = await retry(() =>getBalance(token), 'getBalance');

                // @MENU: 2 - Claim Daily Reward
                if (choice == '2') {
                    const reward = await retry(() => claimDailyReward(token), 'claimDailyReward');

                    if (reward) {
                        console.log(` # Daily reward claimed successfully!`);
                    }

                    console.log(`   $ Balance '@${username}': ${balance.availableBalance} BP`);
                    const runAgain = await askQuestion('\n   ? Run daily reward claim auto 24h? (y/n): ');

                    if (['yes', 'ye', 'y'].includes(runAgain.toLowerCase())) {
                        cronJobRunning = true;
                        console.log(' [-] Setting up daily reward cron job...');
                        setupDailyReward(queries).then(() => {
                            console.log(' [-] Daily reward cron job has been completed.');
                            cronJobRunning = false;
                        }).catch(error => {
                            console.error(' [!] Error setting up daily reward cron job:', error);
                            cronJobRunning = false;
                        });

                        console.log(' [-] Cron job is set, exiting the main loop.');
                        break;
                    }
                }
                
                // @MENU: 3 - Auto Playing Tickets
                if (choice == '3') {
                    let i = 0;
                    if (balance.playPasses > 0) {
                        let counter = balance.playPasses;
                        while (counter > 0) {
                            i++;
                            try {
                                const gameData = await retry(() => getGameId(token), 'getGameId', 10);
                                
                                console.log(`\n [>] Wait for 1 minute.. (${i}/${balance.playPasses})`);
                                await sleep(60000);

                                const randPoints = Math.floor(Math.random() * (MAX_POINT - MIN_POINT + 1)) + MIN_POINT;
                                const letsPlay = await retry(() => claimGamePoints(token, gameData.gameId, randPoints), 'claimGamePoints');
                                
                                if (letsPlay === 'OK') {
                                    const balance = await retry(() => getBalance(token), 'getBalance');
                                    console.log(` [>] Play game success! Your balance now: ${balance.availableBalance} BLUM (+${randPoints})`);
                                }
                            } catch (error) {
                                console.error(' [!] An error occurred:', error);
                                break;
                            }
                            counter--;
                        }
                    } else {
                        await askQuestion(`\n [!] You can't play, you have ${balance.playPasses} chance(s). [ENTER]`);
                        continue;
                    }
                }
                
                // @MENU: 4 - Auto Task
                if (choice == '4') {
                    const tasksData = await retry(() => getTasks(token), 'getTasks');

                    tasksData.forEach((category) => {
                        category.tasks.forEach(async (task) => {
                            if (task.status === 'FINISHED') {
                                console.log(`⏭️  Task "${task.title}" is already completed.`);
                            } else if (task.status === 'NOT_STARTED') {
                                console.log(` [#] Task "${task.title}" is not started yet. Starting now...`);

                                const startedTask = await retry(() => startTask(token, task.id, task.title), 'startTask');

                                if (startedTask) {
                                    console.log(` [#] Task "${startedTask.title}" has been started!`);

                                    try {
                                        const claimedTask = await retry(() => claimTaskReward(token, task.id), 'claimTaskReward');
                                        console.log(` [#] Task "${claimedTask.title}" has been claimed!`);
                                        console.log(` [#] Reward: ${claimedTask.reward}`);
                                    } catch (error) {
                                        console.log(` [#] Unable to claim task "${task.title}", please try to claim it manually.`);
                                    }
                                }
                            } else if (
                                task.status === 'STARTED' ||
                                task.status === 'READY_FOR_CLAIM'
                            ) {
                                try {
                                    const claimedTask = await retry(() => claimTaskReward(token, task.id), 'claimTaskReward');

                                    console.log(` [>] Task "${claimedTask.title}" has been claimed!`);
                                    console.log(` [>] Reward: ${claimedTask.reward}`);
                                } catch (error) {
                                    console.log(` [!] Unable to claim task "${task.title}".`);
                                }
                            }
                            
                            const delay = Math.floor(Math.random() * (MAX_DELAY_PER_TASK - MIN_DELAY_PER_TASK + 1)) + MIN_DELAY_PER_TASK;
                            await sleep(delay);
                        });
                    });

                    await askQuestion('\n [!] Back to main menu [ENTER]');
                }
                
                // @MENU: 5 - Claim Farm Reward
                if (choice == '5') {
                    const claimResponse = await retry(() => claimFarmReward(token), 'claimFarmReward');

                    if (claimResponse) {
                        console.log(' [#] Farm reward claimed successfully!');
                    }

                    const runAgain = await askQuestion(' [?] Run farm reward claim every 9 hours? (y/n): ');

                    if (runAgain.toLowerCase() === 'yes' || runAgain.toLowerCase() === 'ye' || runAgain.toLowerCase() === 'y') {
                        cronJobRunning = true;
                        console.log(' [-] Setting up daily reward cron job...');
                        setupFarmReward(queries).then(() => {
                            console.log(' [-] Daily reward cron job has been completed.');
                            cronJobRunning = false;
                        }).catch(error => {
                            console.error(' [!] Error setting up daily reward cron job:', error);
                            cronJobRunning = false;
                        });

                        console.log(' [-] Cron job is set, exiting the main loop.');
                        break;
                    }
                }
                
                // @MENU: 6 - Start Farming Session
                if (choice == '6') {
                    try {
                        const farmingSession = await retry(() => startFarmingSession(token), 'startFarmingSession');
                
                        console.log(` [#] Farming session started!`);
                        console.log(` [#] Start time: ${formatDate(farmingSession.startTime)}`);
                        console.log(` [#] End time: ${formatDate(farmingSession.endTime)}`);
                
                        cronJobRunning = true;
                        console.log(' [-] Setting up farming session cron job...');

                        await Promise.all([
                            setupCronJob(queries),
                            setupBalanceCheck(queries)
                        ]);
                
                        console.log(' [-] All cron jobs have been completed.');
                    } catch (error) {
                        console.error(' [!] Error setting up cron jobs:', error);
                    }

                    break;
                }
            }
        } else {
            console.log(' [*] A cron job is currently running. Please wait...');
            await sleep(1000);
        }
    }

    if (cronJobRunning) {
        console.log(' > Cron job is running.');
        rl.close();
        await new Promise(resolve => setInterval(resolve, 1000 * 60 * 60 * 24));
    }
})();