/**
 * Utility functions for formatting issues into simplified human-readable strings
 * specifically for the Leadership Dashboard.
 */

interface IssueData {
    issue_type?: string;
    rule_id?: string;
    entity?: string;
    description?: string;
    metadata?: Record<string, any>;
}

export function formatLeadershipIssue(issue: IssueData): string {
    const type = issue.issue_type;
    const ruleId = issue.rule_id || "";
    const entity = (issue.entity || "record").toLowerCase();

    // Format entity name for display (singular)
    const entityName = entity.replace(/s$/, ""); // Basic singularization
    const capitalizedEntity = entityName.charAt(0).toUpperCase() + entityName.slice(1);

    // Handle Duplicates
    if (type === "duplicate" || ruleId.startsWith("dup.")) {
        const parts = ruleId.split(".");
        let detail = "";

        if (parts.length >= 3) {
            const rulePart = parts[2].replace(/_20\d{6,14}$/, "");
            detail = rulePart.replace(/_/g, " ");
        }

        return `${capitalizedEntity} with duplicate ${detail || "information"}`;
    }

    // Handle Missing Links
    if (type === "missing_link" || ruleId.startsWith("link.")) {
        const parts = ruleId.split(".");
        let relationship = "";

        if (parts.length >= 3) {
            relationship = parts[2].replace(/_/g, " ");
        }

        return `${capitalizedEntity} missing linked ${relationship || "record"}`;
    }

    // Handle Attendance
    if (type === "attendance" || ruleId.startsWith("attendance.")) {
        const parts = ruleId.split(".");
        let metric = "";

        if (parts.length >= 2) {
            metric = parts[1].replace(/_/g, " ");
        }

        return `${capitalizedEntity} with ${metric || "attendance issue"}`;
    }

    // Handle Missing Fields
    if (type === "missing_field" || ruleId.startsWith("required_field_rule.") || ruleId.startsWith("required_field.") || ruleId.startsWith("required.")) {
        let field = "";

        if (ruleId.startsWith("required_field_rule.")) {
            // Format: required_field_rule.entity.field_name_timestamp
            field = ruleId.split(".").slice(2).join(" ").replace(/_20\d{6,14}$/, "");
        } else if (ruleId.startsWith("required_field.")) {
            // Format: required_field.entity.field_name (e.g., required_field.contractors.email)
            field = ruleId.split(".")[2] || "";
        } else if (ruleId.startsWith("required.")) {
            // Format: required.entity.field_name
            field = ruleId.split(".")[2] || "";
        } else {
            // Try to find field in metadata
            field = issue.metadata?.field || "";

            // If still missing, try to extract from description (top-level or metadata)
            const desc = issue.description || issue.metadata?.description;
            if (!field && desc) {
                // Patterns: "Missing required field: Name", "Field 'Name' is empty", etc.
                const patterns = [
                    /Missing (?:required )?field:?\s*['"]?([^'"]+)['"]?/i,
                    /Field ['"]?([^'"]+)['"]? is empty/i,
                    /is missing required field ['"]?([^'"]+)['"]?/i,
                    /([^ ]+) is missing/i
                ];

                for (const pattern of patterns) {
                    const match = desc.match(pattern);
                    if (match && match[1]) {
                        field = match[1].trim();
                        // If it matches exactly "required information", keep searching
                        if (field.toLowerCase() === "required information") continue;
                        break;
                    }
                }
            }
        }

        const formattedField = field.replace(/_/g, " ").toUpperCase();
        return `${capitalizedEntity} missing ${formattedField || "required information"}`;
    }

    // Default fallback
    return `${capitalizedEntity} has a data integrity issue`;
}
