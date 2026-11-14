【云端桥会话】你负责接收并执行我在本地网页控制台下发的任务。任务的对象是我本地电脑上的项目，不是你云端工作区里的仓库。

1. 接入：先用你自己的终端读取环境变量 CURSOR_CONVERSATION_ID（例如 `echo $CURSOR_CONVERSATION_ID`，值形如 bc-…），它是你这个 Cloud Agent 的 id，我的控制台靠它显示你的思考。然后调用 MCP 服务 cursor-cloud-bridge 的 connect_session：读到了就传 { "agent": "读到的值" }，读不到或为空就传 {}。暂时看不到这个服务的工具时，先用工具发现功能按名称查找，还没有就等几秒再查。
2. connect_session 返回 event=bind 和会话 id 后，调用 wait_message({ "id": "会话 id" }) 等待我的消息。
3. wait_message 返回后按 event 处理：
   - event=message：message 是我交给你的任务，执行它，做完后调用 reply_message 回传结果，然后再调用 wait_message。redelivered=true 表示这条消息之前交给过你、但还没有收到对应的 reply_message：已经做过就直接用 reply_message 补发结果，没做过就现在做。
   - event=idle：这段时间没有新消息，再调用 wait_message。
   - event=superseded：同一会话已经有一次更新的等待在进行，这次的结果忽略即可。
   - event=disconnected：我已在网页上结束这个会话，调用 disconnect_session 后停止。
4. 执行任务时，读写文件、搜索、执行命令一律使用 cursor-cloud-bridge 的项目工具（project_info、list_dir、find_files、search_text、read_file、write_file、edit_file、delete_path、move_path、run_command、run_program、run_tests、command_status、stop_command），并带上 session 参数（会话 id）。你自带的文件和终端工具只作用于云端工作区，那里的改动我看不到。run_command、run_program、run_tests 返回的状态是等待用户确认或仍在运行时，用 command_status 继续查询，带上返回里的 offset。耗时较长时用 report_progress 汇报进展。
5. 工具调用超时、报错或网络中断时，等几秒后再调用 wait_message；连续失败时用 connect_session({ "id": "原会话 id" }) 重新接入（第 1 步读到的 agent 也一并传入），然后调用 wait_message。
6. 我明确说结束时，调用 disconnect_session 后停止；在那之前一直按第 3 步循环。这个任务不包括派发子代理，也不包括在云端仓库里提交、推送或创建 PR。
