/**
 * Utility functions for formatting rule IDs to human-readable format
 */

export function formatRuleId(ruleId: string): string {
  if (!ruleId) return ruleId;

  // Handle duplicate rules
  if (ruleId.startsWith("dup.")) {
    const parts = ruleId.split(".");
    if (parts.length >= 3) {
      let rulePart = parts[2]; // email_dob, phone_name, etc.
      
      // Remove timestamp if present (format: rulePart_YYYYMMDDHHMMSS)
      rulePart = rulePart.replace(/_20\d{6,14}$/, "");

      // Map rule parts to human-readable descriptions
      const ruleMap: Record<string, string> = {
        // Student rules
        email_dob: "email and date of birth",
        phone_name: "phone and name",
        parents_campus: "parents and campus",
        name_campus: "name and campus",
        parent_overlap: "parent overlap",
        truth_id: "Truth ID",
        email: "email address",
        phone: "phone number",
        name_exact: "exact name match",
        name_first_similar: "first name exact, last name similar",
        name_last_similar: "last name exact, first name similar",
        name_similar: "name similarity",
        // Parent rules
        name_student: "name and linked students",
        address: "address",
        // Contractor rules
        ein: "EIN or business ID",
        email_phone: "email and phone",
        campus_name: "campus and name",
      };

      const ruleDescription = ruleMap[rulePart] || rulePart.replace(/_/g, " ");

      return `Duplicate: ${ruleDescription}`;
    }
  }

  // Handle link rules
  if (ruleId.startsWith("link.")) {
    const parts = ruleId.split(".");
    if (parts.length >= 4) {
      const entity = parts[1];
      const relationship = parts[2];
      const issueType = parts[3]; // orphan, min, max, etc.

      const issueTypeMap: Record<string, string> = {
        orphan: "orphaned link",
        min: "missing required link",
        max: "too many links",
        inactive: "inactive link",
        bidirectional: "bidirectional mismatch",
        cross_entity_mismatch: "cross-entity mismatch",
      };

      const entityName = entity.charAt(0).toUpperCase() + entity.slice(1);
      const issueDesc = issueTypeMap[issueType] || issueType;

      return `${entityName} ${issueDesc}: ${relationship}`;
    }
  }

  // Handle required field rules - new format: required_field_rule.{entity}.{field_name}
  if (ruleId.startsWith("required_field_rule.")) {
    const parts = ruleId.split(".");
    if (parts.length >= 3) {
      let field = parts.slice(2).join("."); // Handle field names with dots

      // Remove timestamp if present (format: field_name_YYYYMMDDHHMMSS or field_name_YYYYMMDD)
      field = field.replace(/_20\d{6,14}$/, ""); // Remove trailing timestamp pattern

      const fieldName = field.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());

      return `Required Field: ${fieldName}`;
    }
  }

  // Handle old format: required.{entity}.{field} or {entity}_{field}_{timestamp}
  if (ruleId.startsWith("required.")) {
    const parts = ruleId.split(".");
    if (parts.length >= 3) {
      let field = parts[2];

      // Remove timestamp if present
      field = field.replace(/_20\d{6,14}$/, "");

      const fieldName = field.replace(/_/g, " ");

      return `Missing required field: ${fieldName}`;
    }
  }

  // Handle old format: {entity}_{field}_{timestamp} (e.g., contractors_field_name_20250127123456)
  const timestampPattern = /^(.+)_20\d{6,14}$/;
  if (timestampPattern.test(ruleId)) {
    const match = ruleId.match(timestampPattern);
    if (match) {
      const baseName = match[1];
      // Check if it matches entity_field pattern
      const entityFieldMatch = baseName.match(/^(\w+)_(.+)$/);
      if (entityFieldMatch) {
        const [, , field] = entityFieldMatch;
        const fieldName = field.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
        return `Required Field: ${fieldName}`;
      }
      // Otherwise just format the base name
      return baseName.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    }
  }

  // Handle attendance rules
  if (ruleId.startsWith("attendance.")) {
    const parts = ruleId.split(".");
    if (parts.length >= 2) {
      const metric = parts[1];
      
      // Map common attendance metrics to human-readable names
      const metricMap: Record<string, string> = {
        excessive_absences: "excessive absences",
        high_absence_rate: "high absence rate",
        consecutive_absences: "consecutive absences",
        absence_threshold: "absence threshold exceeded",
      };
      
      const metricName = metricMap[metric] || metric.replace(/_/g, " ");

      return `Attendance: ${metricName}`;
    }
  }

  // Default: return as-is or format with underscores replaced
  // Remove timestamp if present before formatting
  let cleanedRuleId = ruleId.replace(/_20\d{6,14}$/, ""); // Remove trailing timestamp
  
  // Capitalize first letter of each word for better readability
  const formatted = cleanedRuleId.replace(/_/g, " ").replace(/\./g, ": ");
  return formatted
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
