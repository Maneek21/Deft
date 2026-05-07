'use client';

import { useEffect, useRef, useCallback } from 'react';
import {
  forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide,
  type SimulationNodeDatum, type SimulationLinkDatum,
} from 'd3-force';
import { select } from 'd3-selection';
import { drag as d3Drag } from 'd3-drag';
import { zoom as d3Zoom, zoomIdentity } from 'd3-zoom';

const TYPE_COLORS: Record<string, string> = {
  concept: '#8B5CF6',
  entity: '#06B6D4',
  decision: '#D4A853',
  resource: '#5B8FA8',
  procedure: '#C97B6B',
  preference: '#EC4899',
  fact: '#7C9885',
};

interface GraphNode extends SimulationNodeDatum {
  id: string;
  slug: string;
  title: string;
  type: string;
  confidence: number;
  linkCount: number;
}

interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  context: string | null;
}

interface Props {
  nodes: { id: string; slug: string; title: string; type: string; confidence: number }[];
  edges: { source: string; target: string; context: string | null }[];
  onNodeClick: (slug: string) => void;
}

export default function KnowledgeGraph({ nodes, edges, onNodeClick }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const render = useCallback(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container || nodes.length === 0) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    // Clear previous
    select(svg).selectAll('*').remove();

    // Calculate link counts per node
    const linkCounts: Record<string, number> = {};
    edges.forEach(e => {
      linkCounts[e.source as string] = (linkCounts[e.source as string] || 0) + 1;
      linkCounts[e.target as string] = (linkCounts[e.target as string] || 0) + 1;
    });

    // Create simulation data
    const simNodes: GraphNode[] = nodes.map(n => ({
      ...n,
      linkCount: linkCounts[n.id] || 0,
    }));

    const simEdges: GraphEdge[] = edges.map(e => ({ ...e }));

    // Create SVG groups
    const svgEl = select(svg)
      .attr('width', width)
      .attr('height', height);

    const g = svgEl.append('g');

    // Zoom behavior
    const zoomBehavior = d3Zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    svgEl.call(zoomBehavior);

    // Center initial view
    svgEl.call(zoomBehavior.transform, zoomIdentity.translate(width / 2, height / 2).scale(0.9));

    // Draw edges
    const link = g.append('g')
      .selectAll('line')
      .data(simEdges)
      .enter()
      .append('line')
      .attr('stroke', '#888')
      .attr('stroke-opacity', 0.35)
      .attr('stroke-width', 1.5);

    // Draw nodes
    const nodeGroup = g.append('g')
      .selectAll('g')
      .data(simNodes)
      .enter()
      .append('g')
      .attr('cursor', 'pointer')
      .on('click', (_event, d) => onNodeClick(d.slug));

    // Node circles
    nodeGroup.append('circle')
      .attr('r', d => Math.max(8, 12 + d.linkCount * 4))
      .attr('fill', d => TYPE_COLORS[d.type] || '#7C9885')
      .attr('fill-opacity', d => 0.15 + d.confidence * 0.2)
      .attr('stroke', d => TYPE_COLORS[d.type] || '#7C9885')
      .attr('stroke-width', 2)
      .attr('stroke-opacity', 0.8);

    // Dashed ring for low confidence
    nodeGroup.filter(d => d.confidence < 0.5)
      .append('circle')
      .attr('r', d => Math.max(8, 12 + d.linkCount * 4) + 4)
      .attr('fill', 'none')
      .attr('stroke', d => TYPE_COLORS[d.type] || '#7C9885')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3')
      .attr('stroke-opacity', 0.4);

    // Node labels
    nodeGroup.append('text')
      .text(d => d.title.length > 20 ? d.title.slice(0, 18) + '...' : d.title)
      .attr('text-anchor', 'middle')
      .attr('dy', d => Math.max(8, 12 + d.linkCount * 4) + 14)
      .attr('font-size', '11px')
      .attr('fill', 'var(--text-secondary)')
      .attr('font-family', 'inherit');

    // Hover effects
    nodeGroup
      .on('mouseenter', function (_event, d) {
        select(this).select('circle').attr('stroke-width', 3).attr('fill-opacity', 0.35 + d.confidence * 0.2);
        select(this).select('text').attr('fill', 'var(--text-primary)').attr('font-weight', '600');
        // Highlight connected edges
        link.attr('stroke-opacity', l => {
          const src = typeof l.source === 'object' ? l.source.id : l.source;
          const tgt = typeof l.target === 'object' ? l.target.id : l.target;
          return (src === d.id || tgt === d.id) ? 0.9 : 0.1;
        }).attr('stroke-width', l => {
          const src = typeof l.source === 'object' ? l.source.id : l.source;
          const tgt = typeof l.target === 'object' ? l.target.id : l.target;
          return (src === d.id || tgt === d.id) ? 2.5 : 1;
        }).attr('stroke', l => {
          const src = typeof l.source === 'object' ? l.source.id : l.source;
          const tgt = typeof l.target === 'object' ? l.target.id : l.target;
          return (src === d.id || tgt === d.id) ? (TYPE_COLORS[d.type] || '#7C9885') : 'var(--border-default)';
        });
      })
      .on('mouseleave', function () {
        select(this).select('circle').attr('stroke-width', 2).attr('fill-opacity', (d: any) => 0.15 + d.confidence * 0.2);
        select(this).select('text').attr('fill', 'var(--text-secondary)').attr('font-weight', 'normal');
        link.attr('stroke-opacity', 0.35).attr('stroke-width', 1.5).attr('stroke', '#888');
      });

    // Drag behavior
    const dragBehavior = d3Drag<SVGGElement, GraphNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    nodeGroup.call(dragBehavior as any);

    // Force simulation
    const simulation = forceSimulation(simNodes)
      .force('link', forceLink<GraphNode, GraphEdge>(simEdges)
        .id(d => d.id)
        .distance(100)
        .strength(0.5))
      .force('charge', forceManyBody().strength(-200))
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide<GraphNode>().radius(d => Math.max(8, 12 + d.linkCount * 4) + 20))
      .on('tick', () => {
        link
          .attr('x1', d => (d.source as GraphNode).x!)
          .attr('y1', d => (d.source as GraphNode).y!)
          .attr('x2', d => (d.target as GraphNode).x!)
          .attr('y2', d => (d.target as GraphNode).y!);

        nodeGroup.attr('transform', d => `translate(${d.x},${d.y})`);
      });

    return () => {
      simulation.stop();
    };
  }, [nodes, edges, onNodeClick]);

  useEffect(() => {
    const cleanup = render();
    const handleResize = () => render();
    window.addEventListener('resize', handleResize);
    return () => {
      cleanup?.();
      window.removeEventListener('resize', handleResize);
    };
  }, [render]);

  return (
    <div ref={containerRef} className="w-full h-full min-h-[400px]">
      <svg ref={svgRef} className="w-full h-full" />
    </div>
  );
}
