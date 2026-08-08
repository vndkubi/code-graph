# Kế hoạch Refactor MCP Tools

## Mục tiêu
- Loại bỏ 12 công cụ TokenOpt legacy không cần thiết
- Gộp các công cụ truy vấn trùng lặp
- Chỉ giữ lại 12 công cụ thiết yếu
- Giảm 64% số lượng công cụ và 65% kích thước mã nguồn

## 12 Công cụ Legacy cần LOẠI BỎ (tokenopt/mcp.ts)
1. tokenopt_run_command - Thay thế bằng shell command trực tiếp
2. tokenopt_project_facts - Thay thế bằng V2 generate_repo_atlas
3. tokenopt_prepare_java_diff - Chức năng Java-specific hẹp
4. tokenopt_jakarta_annotation_filter - Chức năng filter hẹp
5. tokenopt_assemble_spring_context - Thay thế bằng V2 get_flow_pack
6. tokenopt_business_contract - Thay thế bằng V2 compile_evidence
7. tokenopt_impact_analysis - Thay thế bằng V2 get_change_pack/simulate_patch_impact
8. tokenopt_symbols_find - Thay thế bằng V2 search_symbol
9. tokenopt_symbol_packet - Thay thế bằng V2 codegraph_context
10. tokenopt_test_neighbors - Thay thế bằng V2 find_tests_for
11. tokenopt_failure_packet - Thay thế bằng V2 review_patch
12. tokenopt_tracebug_packet - Thay thế bằng V2 codegraph_context

## 12 Công cụ THIẾT YẾU cần GIỮ LẠI

### Nhóm Core (4 tools):
1. **contextgate_get_context** - Cổng chính để lấy context repository
2. **tokenopt_compile_evidence** - Biên dịch evidence packet
3. **tokenopt_search** - Tìm kiếm cơ bản
4. **tokenopt_read_file** - Đọc file cụ thể

### Nhóm V2 Core (8 tools):
5. **codegraph_context** - Lấy context từ CodeGraph V2
6. **codegraph_slice** - Lấy slice code
7. **codegraph_checkpoint** - Quản lý checkpoint task
8. **codegraph_status** - Kiểm tra trạng thái CodeGraph
9. **get_flow_pack** - Gói flow analysis
10. **get_research_pack** - Gói research
11. **get_change_pack** - Gói change analysis
12. **review_patch** - Review patch/diff

## Các công cụ V2 sẽ gộp/bỏ:
- search_symbol, search_files, search_code → gộp vào codegraph_context
- get_file_summary, get_file_slice → gộp vào codegraph_slice
- get_dependencies, get_dependents, trace_dependencies → gộp vào get_flow_pack
- get_callers, get_callees, find_references → gộp vào codegraph_context
- find_endpoints, explain_endpoint → gộp vào get_flow_pack
- get_impact_radius, impact_of_symbol → gộp vào get_change_pack
- simulate_patch_impact → gộp vào review_patch
- find_tests_for → tích hợp vào get_change_pack
- get_context_packet, compile_evidence → gộp vào tokenopt_compile_evidence
- generate_repo_atlas → tích hợp vào codegraph_status
- get_index_stats → tích hợp vào codegraph_status

## File cần sửa:
1. /workspace/src/tokenopt/mcp.ts - Loại bỏ 12 tools legacy
2. /workspace/src/v2/mcp/tools.ts - Tinh giản còn 12 tools core
3. /workspace/src/v2/mcp/proxy.ts - Cập nhật handlers
4. /workspace/src/cli.ts - Cập nhật CLI nếu cần
