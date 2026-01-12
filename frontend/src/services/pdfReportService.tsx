import jsPDF from "jspdf";
import { chartToImage } from "../utils/chartToImage";
import type { RunHistoryItem } from "../hooks/useFirestoreRuns";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import React from "react";
import { createRoot } from "react-dom/client";

const COLORS = {
  critical: "#dc2626",
  warning: "#d97706",
  info: "#2563eb",
  success: "#16a34a",
  duplicate: "#8b5cf6",
  missing_link: "#f59e0b",
  attendance: "#ef4444",
  missing_field: "#06b6d4",
};

export async function generateRunReport(run: RunHistoryItem): Promise<Blob> {
  const byType = run.counts?.by_type || {};
  const bySeverity = run.counts?.by_severity || {};

  let typeChartImage: string | undefined;
  let severityChartImage: string | undefined;

  try {
    if (Object.keys(byType).length > 0) {
      typeChartImage = await generateTypeChart(byType);
    }
  } catch (error) {
    console.error("Failed to generate type chart:", error);
  }

  try {
    if (Object.keys(bySeverity).length > 0) {
      severityChartImage = await generateSeverityChart(bySeverity);
    }
  } catch (error) {
    console.error("Failed to generate severity chart:", error);
  }

  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "letter",
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  let yPos = margin;

  // Helper to add text with word wrap
  const addText = (text: string, fontSize: number, isBold = false) => {
    doc.setFontSize(fontSize);
    doc.setFont("helvetica", isBold ? "bold" : "normal");
    const lines = doc.splitTextToSize(text, pageWidth - 2 * margin);
    doc.text(lines, margin, yPos);
    yPos += lines.length * (fontSize * 0.4) + 5;
    return lines.length;
  };

  // Header
  doc.setFillColor(31, 79, 72);
  doc.rect(0, 0, pageWidth, 30, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(24);
  doc.setFont("helvetica", "bold");
  doc.text("Integrity Scan Report", margin, 20);

  yPos = 35;
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Run ID: ${run.run_id || run.id}`, margin, yPos);
  yPos += 6;

  const runDate =
    run.started_at?.toDate?.() || run.ended_at?.toDate?.() || new Date();
  const formattedDate =
    runDate instanceof Date
      ? runDate.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Unknown";
  doc.text(`Scan Date: ${formattedDate}`, margin, yPos);
  yPos += 6;

  const generatedDate = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  doc.text(`Generated: ${generatedDate}`, margin, yPos);
  yPos += 15;

  // Summary Section
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text("Summary", margin, yPos);
  yPos += 10;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");

  // Status badge color
  const statusLower = (run.status || "").toLowerCase();
  let statusColor: [number, number, number] = [22, 163, 74]; // green default
  if (statusLower === "error") {
    statusColor = [220, 38, 38];
  } else if (statusLower === "warning") {
    statusColor = [217, 119, 6];
  }

  // Summary boxes
  const boxWidth = (pageWidth - 2 * margin - 10) / 3;
  let xPos = margin;

  // Status
  doc.setFillColor(245, 245, 245);
  doc.roundedRect(xPos, yPos, boxWidth, 20, 2, 2, "F");
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(9);
  doc.text("STATUS", xPos + 5, yPos + 7);
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(statusColor[0], statusColor[1], statusColor[2]);
  doc.text(run.status, xPos + 5, yPos + 14);
  xPos += boxWidth + 5;

  // Mode
  doc.setFillColor(245, 245, 245);
  doc.roundedRect(xPos, yPos, boxWidth, 20, 2, 2, "F");
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(9);
  xPos += boxWidth + 5;

  // Total Issues
  doc.setFillColor(245, 245, 245);
  doc.roundedRect(xPos, yPos, boxWidth, 20, 2, 2, "F");
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text("TOTAL ISSUES", xPos + 5, yPos + 7);
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.text(run.anomalies.toLocaleString(), xPos + 5, yPos + 14);
  yPos += 25;

  // Second row
  xPos = margin;
  doc.setFillColor(245, 245, 245);
  doc.roundedRect(xPos, yPos, boxWidth, 20, 2, 2, "F");
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text("TRIGGER", xPos + 5, yPos + 7);
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  const triggerText =
    run.trigger === "manual"
      ? "Manual"
      : run.trigger === "nightly"
      ? "Nightly"
      : run.trigger === "weekly"
      ? "Weekly"
      : run.trigger;
  doc.text(triggerText, xPos + 5, yPos + 14);
  xPos += boxWidth + 5;

  doc.setFillColor(245, 245, 245);
  doc.roundedRect(xPos, yPos, boxWidth, 20, 2, 2, "F");
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text("DURATION", xPos + 5, yPos + 7);
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.text(run.duration, xPos + 5, yPos + 14);
  xPos += boxWidth + 5;

  doc.setFillColor(245, 245, 245);
  doc.roundedRect(xPos, yPos, boxWidth, 20, 2, 2, "F");
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text("TIME", xPos + 5, yPos + 7);
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.text(run.time, xPos + 5, yPos + 14);
  yPos += 30;

  // Charts
  if (typeChartImage) {
    if (yPos > pageHeight - 100) {
      doc.addPage();
      yPos = margin;
    }
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text("Issues by Type", margin, yPos);
    yPos += 10;

    try {
      // jsPDF can use base64 data URLs directly
      // Estimate dimensions (600x300px chart = ~158x79mm at 96dpi)
      const imgWidth = 170;
      const imgHeight = 85;
      if (yPos + imgHeight > pageHeight - margin) {
        doc.addPage();
        yPos = margin;
      }
      doc.addImage(typeChartImage, "PNG", margin, yPos, imgWidth, imgHeight);
      yPos += imgHeight + 15;
    } catch (error) {
      console.error("Failed to add type chart image:", error);
    }
  }

  if (severityChartImage) {
    if (yPos > pageHeight - 100) {
      doc.addPage();
      yPos = margin;
    }
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text("Issues by Severity", margin, yPos);
    yPos += 10;

    try {
      // jsPDF can use base64 data URLs directly
      const imgWidth = 170;
      const imgHeight = 85;
      if (yPos + imgHeight > pageHeight - margin) {
        doc.addPage();
        yPos = margin;
      }
      doc.addImage(
        severityChartImage,
        "PNG",
        margin,
        yPos,
        imgWidth,
        imgHeight
      );
      yPos += imgHeight + 15;
    } catch (error) {
      console.error("Failed to add severity chart image:", error);
    }
  }

  // Issue breakdown (if no charts)
  if (!typeChartImage && !severityChartImage) {
    if (yPos > pageHeight - 80) {
      doc.addPage();
      yPos = margin;
    }
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text("Issue Breakdown", margin, yPos);
    yPos += 10;

    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("By Type:", margin, yPos);
    yPos += 8;

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    if (Object.keys(byType).length > 0) {
      Object.entries(byType).forEach(([type, count]) => {
        const typeLabel = type
          .replace(/_/g, " ")
          .replace(/\b\w/g, (l) => l.toUpperCase());
        doc.text(`${typeLabel}:`, margin, yPos);
        doc.setFont("helvetica", "bold");
        doc.text(count.toString(), pageWidth - margin - 20, yPos);
        doc.setFont("helvetica", "normal");
        yPos += 6;
      });
    } else {
      doc.setTextColor(153, 153, 153);
      doc.text("No type data available", margin, yPos);
      doc.setTextColor(0, 0, 0);
      yPos += 6;
    }

    yPos += 5;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("By Severity:", margin, yPos);
    yPos += 8;

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    if (Object.keys(bySeverity).length > 0) {
      Object.entries(bySeverity).forEach(([severity, count]) => {
        const severityLabel =
          severity.charAt(0).toUpperCase() + severity.slice(1);
        doc.text(`${severityLabel}:`, margin, yPos);
        doc.setFont("helvetica", "bold");
        doc.text(count.toString(), pageWidth - margin - 20, yPos);
        doc.setFont("helvetica", "normal");
        yPos += 6;
      });
    } else {
      doc.setTextColor(153, 153, 153);
      doc.text("No severity data available", margin, yPos);
      doc.setTextColor(0, 0, 0);
    }
  }

  // Footer
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(9);
    doc.setTextColor(153, 153, 153);
    doc.text(
      `Generated by Data Integrity Monitor • ${generatedDate}`,
      margin,
      pageHeight - 10,
      { align: "center" }
    );
  }

  const blob = doc.output("blob");
  return blob;
}

async function generateTypeChart(
  byType: Record<string, number>
): Promise<string> {
  const data = Object.entries(byType).map(([name, value]) => ({
    name: name.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
    value,
    fill: COLORS[name as keyof typeof COLORS] || "#6b7280",
  }));

  const container = document.createElement("div");
  container.style.width = "600px";
  container.style.height = "300px";
  container.style.position = "fixed";
  container.style.top = "0";
  container.style.left = "0";
  container.style.zIndex = "-1";
  container.style.backgroundColor = "#ffffff";
  container.style.visibility = "hidden";
  document.body.appendChild(container);

  const root = createRoot(container);

  return new Promise((resolve, reject) => {
    try {
      root.render(
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 12, fill: "#374151" }}
              angle={-45}
              textAnchor="end"
              height={80}
            />
            <YAxis tick={{ fontSize: 12, fill: "#374151" }} />
            <Tooltip
              contentStyle={{
                backgroundColor: "#ffffff",
                border: "1px solid #e5e7eb",
                borderRadius: "4px",
              }}
            />
            <Legend />
            <Bar dataKey="value" fill="#1f4f48" radius={[4, 4, 0, 0]}>
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );

      setTimeout(async () => {
        try {
          container.style.visibility = "visible";
          await new Promise((resolve) => setTimeout(resolve, 300));
          const imageData = await chartToImage(container, {
            width: 600,
            height: 300,
          });
          document.body.removeChild(container);
          root.unmount();
          resolve(imageData);
        } catch (error) {
          document.body.removeChild(container);
          root.unmount();
          reject(error);
        }
      }, 500);
    } catch (error) {
      document.body.removeChild(container);
      root.unmount();
      reject(error);
    }
  });
}

async function generateSeverityChart(
  bySeverity: Record<string, number>
): Promise<string> {
  const data = Object.entries(bySeverity).map(([name, value]) => ({
    name: name.charAt(0).toUpperCase() + name.slice(1),
    value,
    fill: COLORS[name as keyof typeof COLORS] || "#6b7280",
  }));

  const container = document.createElement("div");
  container.style.width = "600px";
  container.style.height = "300px";
  container.style.position = "fixed";
  container.style.top = "0";
  container.style.left = "0";
  container.style.zIndex = "-1";
  container.style.backgroundColor = "#ffffff";
  container.style.visibility = "hidden";
  document.body.appendChild(container);

  const root = createRoot(container);

  return new Promise((resolve, reject) => {
    try {
      root.render(
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={({ name, percent }) =>
                `${name}: ${(percent * 100).toFixed(0)}%`
              }
              outerRadius={100}
              fill="#8884d8"
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.fill} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: "#ffffff",
                border: "1px solid #e5e7eb",
                borderRadius: "4px",
              }}
            />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      );

      setTimeout(async () => {
        try {
          container.style.visibility = "visible";
          await new Promise((resolve) => setTimeout(resolve, 300));
          const imageData = await chartToImage(container, {
            width: 600,
            height: 300,
          });
          document.body.removeChild(container);
          root.unmount();
          resolve(imageData);
        } catch (error) {
          document.body.removeChild(container);
          root.unmount();
          reject(error);
        }
      }, 500);
    } catch (error) {
      document.body.removeChild(container);
      root.unmount();
      reject(error);
    }
  });
}
